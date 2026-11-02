import express from "express";
import { chatRouter } from "./chat/chat.routes.js";

export function createApp() {
  const app = express();
  app.use(express.json());

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.use("/api", chatRouter);

  return app;
}
