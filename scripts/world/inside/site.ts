/**
 * The app's site in a world: the app's built copy, served by servePagesSite (scripts/pages-static.ts) OF THE CHECKOUT
 * IT WAS BUILT FROM (mounted at /opt/app-repo), so its headers are the ones the app's build was tested with. The world's TLS proxy
 * answers for the app origin and passes the requests here.
 */
export {};
const bind = process.env["WORLD_BIND"] ?? "";
if (bind === "") throw new Error("WORLD_BIND (this container's address) is required");
const pagesStatic = "/opt/app-repo/scripts/pages-static.ts";
const { servePagesSite }: typeof import("../../pages-static.ts") = await import(pagesStatic);
const server = servePagesSite("/sites/app", 8080, bind);
console.log(JSON.stringify({ event: "ready", role: "site", port: server.port }));
const stop = () => { void server.stop(true); process.exit(0); };
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
