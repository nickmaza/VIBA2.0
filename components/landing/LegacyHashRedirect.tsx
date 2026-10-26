"use client";

import { useEffect } from "react";

// The app used to live at "/", so links like /#chart/NVDA or /#plays
// still exist in bookmarks and shared messages. Send those to /app.
const TABS = /^#(overview|plays|smart|predictive|chart|news)(\/|$)/;

export default function LegacyHashRedirect() {
  useEffect(() => {
    if (TABS.test(window.location.hash)) window.location.replace(`/app${window.location.hash}`);
  }, []);
  return null;
}
