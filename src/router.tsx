import {
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import App from "./App";

// Hash routes also work inside the packaged desktop app without a web server.
const root = createRootRoute({ component: App });
const sort = createRoute({ getParentRoute: () => root, path: "/" });
const collage = createRoute({ getParentRoute: () => root, path: "/collage" });
export const router = createRouter({
  routeTree: root.addChildren([sort, collage]),
  history: createHashHistory(),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
