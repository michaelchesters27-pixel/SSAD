const { schedule } = require("@netlify/functions");
const { runScan } = require("./lib/eve-core");

const scheduledHandler = async () => {
  try {
    const result = await runScan({ source: "scheduled" });
    return {
      statusCode: 200,
      body: JSON.stringify(result)
    };
  } catch (err) {
    console.error("EVE scheduled scan failed:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ ok: false, error: err.message || String(err) })
    };
  }
};

exports.handler = schedule("*/5 * * * *", scheduledHandler);
