#![deny(clippy::all)]

//! Thin napi binding over iroh's endpoint, connection and stream types.
//!
//! It holds no peerkit logic — no access handshake, no framing, no callbacks;
//! those live in the TypeScript transport above it. The binding is pull-based:
//! JavaScript drives the accept and read loops, and each call just waits on the
//! matching iroh future, so the binding never has to push events back into JS.

use std::sync::Arc;

use iroh::endpoint::{presets, Connection, RecvStream, SendStream};
use iroh::{Endpoint, EndpointAddr};
use napi::bindgen_prelude::Buffer;
use napi_derive::napi;
use tokio::sync::Mutex;

/// One ALPN for all peerkit traffic. The individual peerkit protocols run as
/// separate streams on top and are told apart by the layer above.
const PEERKIT_ALPN: &[u8] = b"/peerkit/1";

fn to_err<E: std::fmt::Display>(e: E) -> napi::Error {
    napi::Error::from_reason(e.to_string())
}

#[napi(object)]
pub struct EndpointOptions {
    /// Use n0's production relays + discovery (default `true`). Set `false` for
    /// a direct-only / offline endpoint (relays disabled), e.g. in tests.
    pub relay: Option<bool>,
}

#[napi]
pub struct PeerkitEndpoint {
    ep: Endpoint,
}

#[napi]
impl PeerkitEndpoint {
    /// Bind an endpoint accepting the peerkit ALPN.
    #[napi(factory)]
    pub async fn create(options: Option<EndpointOptions>) -> napi::Result<PeerkitEndpoint> {
        let relay = options.and_then(|o| o.relay).unwrap_or(true);
        let builder = if relay {
            Endpoint::builder(presets::N0)
        } else {
            Endpoint::builder(presets::N0DisableRelay)
        };
        let ep = builder
            .alpns(vec![PEERKIT_ALPN.to_vec()])
            .bind()
            .await
            .map_err(to_err)?;
        Ok(PeerkitEndpoint { ep })
    }

    /// This endpoint's own stable id (EndpointId).
    #[napi]
    pub fn node_id(&self) -> String {
        self.ep.id().to_string()
    }

    /// This endpoint's dialable address (id + relay + direct addrs) as JSON —
    /// the opaque `NodeAddress` peerkit carries in agent-info.
    #[napi]
    pub fn addr(&self) -> napi::Result<String> {
        serde_json::to_string(&self.ep.addr()).map_err(to_err)
    }

    /// Dial a peer by its serialized address over the peerkit ALPN.
    #[napi]
    pub async fn connect(&self, addr_json: String) -> napi::Result<PeerkitConn> {
        let addr: EndpointAddr = serde_json::from_str(&addr_json).map_err(to_err)?;
        let conn = self
            .ep
            .clone()
            .connect(addr, PEERKIT_ALPN)
            .await
            .map_err(to_err)?;
        Ok(PeerkitConn { conn })
    }

    /// Await the next inbound connection (after ALPN negotiation). Rejects once
    /// the endpoint is closed.
    #[napi]
    pub async fn accept(&self) -> napi::Result<PeerkitConn> {
        let incoming = self
            .ep
            .clone()
            .accept()
            .await
            .ok_or_else(|| napi::Error::from_reason("endpoint closed"))?;
        let conn = incoming.await.map_err(to_err)?;
        Ok(PeerkitConn { conn })
    }

    #[napi]
    pub async fn close(&self) {
        self.ep.clone().close().await;
    }
}

#[napi]
pub struct PeerkitConn {
    conn: Connection,
}

#[napi]
impl PeerkitConn {
    /// The remote peer's EndpointId.
    #[napi]
    pub fn remote_id(&self) -> String {
        self.conn.remote_id().to_string()
    }

    /// True when the path carrying application data is a direct IP path
    /// (holepunched), false when still routed via a relay.
    #[napi]
    pub fn is_direct(&self) -> bool {
        self.conn
            .paths()
            .iter()
            .any(|p| p.is_selected() && p.is_ip())
    }

    /// Diagnostic snapshot of open paths, e.g. `[relay,ip*]` (`*` = selected).
    #[napi]
    pub fn path_summary(&self) -> String {
        let paths = self.conn.paths();
        let parts: Vec<String> = paths
            .iter()
            .map(|p| {
                let kind = if p.is_relay() {
                    "relay"
                } else if p.is_ip() {
                    "ip"
                } else {
                    "?"
                };
                format!("{}{}", kind, if p.is_selected() { "*" } else { "" })
            })
            .collect();
        format!("[{}]", parts.join(","))
    }

    /// Open a new outbound bi-directional stream.
    #[napi]
    pub async fn open_bi(&self) -> napi::Result<PeerkitStream> {
        let (send, recv) = self.conn.clone().open_bi().await.map_err(to_err)?;
        Ok(PeerkitStream::new(send, recv))
    }

    /// Await the next inbound bi-directional stream on this connection.
    #[napi]
    pub async fn accept_bi(&self) -> napi::Result<PeerkitStream> {
        let (send, recv) = self.conn.clone().accept_bi().await.map_err(to_err)?;
        Ok(PeerkitStream::new(send, recv))
    }

    /// Close the whole connection, not just a single stream.
    #[napi]
    pub fn close(&self) {
        self.conn.close(0u32.into(), b"closed");
    }
}

/// A bi-directional stream. The send and recv halves are independently locked so
/// a JS read-loop and concurrent writes don't contend.
#[napi]
pub struct PeerkitStream {
    send: Arc<Mutex<SendStream>>,
    recv: Arc<Mutex<RecvStream>>,
}

impl PeerkitStream {
    fn new(send: SendStream, recv: RecvStream) -> Self {
        Self {
            send: Arc::new(Mutex::new(send)),
            recv: Arc::new(Mutex::new(recv)),
        }
    }
}

#[napi]
impl PeerkitStream {
    /// Write all bytes to the send half.
    #[napi]
    pub async fn write(&self, data: Buffer) -> napi::Result<()> {
        let send = self.send.clone();
        let mut guard = send.lock().await;
        guard.write_all(&data).await.map_err(to_err)
    }

    /// Signal end-of-data on the send half (the recv side then sees EOF).
    #[napi]
    pub async fn finish_write(&self) -> napi::Result<()> {
        let send = self.send.clone();
        let mut guard = send.lock().await;
        guard.finish().map_err(to_err)
    }

    /// Read the next chunk from the recv half; resolves to `null` at end of
    /// stream (writer finished).
    #[napi]
    pub async fn read(&self) -> napi::Result<Option<Buffer>> {
        let recv = self.recv.clone();
        let mut guard = recv.lock().await;
        match guard.read_chunk(64 * 1024).await.map_err(to_err)? {
            Some(bytes) => Ok(Some(bytes.to_vec().into())),
            None => Ok(None),
        }
    }

    /// Read everything until the writer finishes, up to `size_limit` bytes.
    /// Handy when a stream carries just one message.
    #[napi]
    pub async fn read_to_end(&self, size_limit: u32) -> napi::Result<Buffer> {
        let recv = self.recv.clone();
        let mut guard = recv.lock().await;
        let bytes = guard
            .read_to_end(size_limit as usize)
            .await
            .map_err(to_err)?;
        Ok(bytes.into())
    }

    /// Tell the peer to stop sending (resets the recv half).
    #[napi]
    pub async fn stop_read(&self) -> napi::Result<()> {
        let recv = self.recv.clone();
        let mut guard = recv.lock().await;
        guard.stop(0u32.into()).map_err(to_err)
    }
}
