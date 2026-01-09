import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";

import routes from "./routes";

const app = express();

/* -------------------- middleware -------------------- */
app.use(cors());
app.use(express.json());

/* -------------------- api routes -------------------- */
app.use("/api", routes);

/* -------------------- static + spa fallback -------------------- */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// IMPORTANT: dist/index.cjs → dist/public
const publicDir = path.join(__dirname, "public");

app.use(express.static(publicDir));

// SPA fallback (must be LAST)
app.get("*", (req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

/* -------------------- server start -------------------- */
const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log(`ThankuMail server running on port ${PORT}`);
});
