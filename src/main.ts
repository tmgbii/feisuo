import { createPinia } from "pinia";
import { createApp } from "vue";
import App from "./App.vue";
import "./styles.css";
import "vue-sonner/style.css";
import "@xterm/xterm/css/xterm.css";

const app = createApp(App);
app.use(createPinia());
app.mount("#app");
