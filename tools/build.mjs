import { readFile, writeFile } from "node:fs/promises";
import { createDetector } from "../core/detector.mjs";
import { createFixtureTools } from "../core/fixture.mjs";
import { createMidiTools } from "../core/midi.mjs";

const project = new URL("../", import.meta.url);
const text = (path) => readFile(new URL(path, project), "utf8");
async function dataURL(path, mime) {
  const file = await readFile(new URL(path, project));
  return "data:" + mime + ";base64," + file.toString("base64");
}

const [template, css, controller, regular, bold, hallmark] = await Promise.all([
  text("app/template.html"), text("app/theme.css"), text("app/controller.js"),
  dataURL("assets/EpsilonDial-Regular.ttf", "font/ttf"),
  dataURL("assets/EpsilonDial-Bold.ttf", "font/ttf"),
  dataURL("assets/epsilon-hallmark.png", "image/png"),
]);
const styles = css.replace("%%DIAL_REGULAR%%", regular).replace("%%DIAL_BOLD%%", bold);
const script = [createDetector, createFixtureTools, createMidiTools]
  .map((factory) => factory.toString()).join("\n\n") + "\n\n" + controller;
const page = template.replaceAll("%%HALLMARK%%", hallmark)
  .replace("%%STYLES%%", () => styles)
  .replace("%%SCRIPT%%", () => script.replace(/<\/script/gi, "<\\/script"));
await writeFile(new URL("Drumagon.html", project), page);
console.log("Built Drumagon.html");
