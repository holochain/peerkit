import {
  configure,
  getAnsiColorFormatter,
  getConsoleSink,
} from "@logtape/logtape";

export const setupTestLogger = async () => {
  await configure({
    sinks: {
      console: getConsoleSink({
        formatter: getAnsiColorFormatter({
          format({ timestamp, level, category, message, record }) {
            let output = `${timestamp} ${level} ${category}`;
            if (typeof record.properties.id === "string") {
              output = output + ` ${record.properties.id}`;
            }
            output = output + `: ${message}`;
            return output;
          },
        }),
      }),
    },
    loggers: [
      {
        category: "peerkit",
        lowestLevel: "info",
        sinks: ["console"],
      },
    ],
  });
};
