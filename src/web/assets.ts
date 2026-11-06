// @ts-nocheck - TypeScript resolves these as JS modules; Bun resolves them as text.
// Client assets are text imports so `bun build --compile` embeds them in the exe.

import appCss from "./assets/app.css" with { type: "text" };
import appJs from "./assets/app.js" with { type: "text" };
import apiJs from "./assets/lib/api.js" with { type: "text" };
import domJs from "./assets/lib/dom.js" with { type: "text" };
import formatJs from "./assets/lib/format.js" with { type: "text" };
import metricsJs from "./assets/lib/metrics.js" with { type: "text" };
import meMenuJs from "./assets/me-menu.js" with { type: "text" };
import aboutJs from "./assets/tabs/about.js" with { type: "text" };
import employeesJs from "./assets/tabs/employees.js" with { type: "text" };
import generateJs from "./assets/tabs/generate.js" with { type: "text" };
import homeJs from "./assets/tabs/home.js" with { type: "text" };
import hooksJs from "./assets/tabs/hooks.js" with { type: "text" };
import logJs from "./assets/tabs/log.js" with { type: "text" };
import scheduleJs from "./assets/tabs/schedule.js" with { type: "text" };
import settingsJs from "./assets/tabs/settings.js" with { type: "text" };

export const CLIENT_ASSETS: Record<string, string> = {
  "app.css": appCss,
  "app.js": appJs,
  "lib/api.js": apiJs,
  "lib/dom.js": domJs,
  "lib/format.js": formatJs,
  "lib/metrics.js": metricsJs,
  "me-menu.js": meMenuJs,
  "tabs/about.js": aboutJs,
  "tabs/employees.js": employeesJs,
  "tabs/generate.js": generateJs,
  "tabs/home.js": homeJs,
  "tabs/hooks.js": hooksJs,
  "tabs/log.js": logJs,
  "tabs/schedule.js": scheduleJs,
  "tabs/settings.js": settingsJs,
};

export function contentTypeFor(path: string): string {
  if (path.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  return "text/plain; charset=utf-8";
}
