import express, { type Request, Response, NextFunction } from "express";
import { createServer } from "http";
import { registerRoutes } from "./routes";
import { setupVite, serveStatic, log } from "./vite";

const app = express();
app.get("/", (_req, res) => {
  res.status(200).send("ThankuMail server is running");
});
