/**
 * react-dom decides at load whether it runs in a browser (whether `input` events exist, among others), and
 * the app's components load it before any test can set up a page. When a test in this run renders into a
 * page (src/lib/page.fixture.ts), react-dom is loaded here with a happy-dom document in place, so a text
 * field's onChange follows its input events whatever order the files load in. The globals go again
 * afterwards: each test opens its own page, and the other tests see no window.
 */
import { readFileSync } from "node:fs";

const rendersPages = process.argv.slice(1).some((file) => /\.test\.tsx?$/.test(file) && readFileSync(file, "utf8").includes("page.fixture.ts"));

if (rendersPages) {
  const { Window } = await import("happy-dom");
  const window = new Window();
  Object.assign(globalThis, { window, document: window.document });
  await import("react-dom/client");
  Reflect.deleteProperty(globalThis, "window");
  Reflect.deleteProperty(globalThis, "document");
  await window.happyDOM.close();
}
