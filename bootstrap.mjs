// app.js initializes the environment before importing server dependencies.
await import("./app.js");

console.log("🔥 BOOTSTRAP ACTIVE", process.platform, process.env.AUTOMIX_ALL_TIMEOUT_MS);
