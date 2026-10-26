// Vue Router: one route per tab (#/feed, #/library, …). Tabs come from the plugins' contributions, so the route takes
// the tab id; App.vue sends unknown ids to the first tab once contributions are known.
import { createRouter, createWebHashHistory } from "vue-router";

const Empty = { render: () => null };

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: "/", redirect: "/feed" },
    { path: "/:tab", component: Empty },
  ],
});
