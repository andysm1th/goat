import { useState } from "react";
import { TextGoat } from "../react";
import { useThemeColor } from "./useThemeColor";

const PAPER = "#bdc0bd",
  TECHNO = "#0b0b0b";

// Frames painted per second. The film is 60; 30 roughly halves the work.
// Set this to 60 to switch back, or compare without rebuilding: ?fps=60
const FRAME_RATE =
  Number(new URLSearchParams(location.search).get("fps")) || 30;

// The demo site is the integration: one <TextGoat /> filling the window.
export function App() {
  const [techno, setTechno] = useState(false);
  useThemeColor(techno ? TECHNO : PAPER);

  return (
    <main>
      <TextGoat
        className="goat"
        frameRate={FRAME_RATE}
        onTechnoChange={setTechno}
      >
        <a slot="controls" href={`${import.meta.env.BASE_URL}embed.html`}>
          Embed
        </a>
        <a slot="controls" href="https://github.com/andysm1th/goat">
          GitHub
        </a>
      </TextGoat>
    </main>
  );
}
