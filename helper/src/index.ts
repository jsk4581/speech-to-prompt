// STP local helper — entry point (WIP scaffold; nothing implemented yet).
//
// Responsibilities:
//   1. Start a localhost server bound to 127.0.0.1 (+ a session token, so other
//      local processes can't inject).
//   2. Open the default browser to the popup (helper/web) — this sidesteps the
//      macOS terminal-TCC microphone trap.
//   3. Receive captured audio → transcribe via a whisper.cpp subprocess.
//   4. Bridge the grill loop between the popup (the View) and the coding agent.
//   5. Hand off exactly one confirmed XML prompt.

export {};
