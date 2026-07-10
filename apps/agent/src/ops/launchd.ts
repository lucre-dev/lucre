import { homedir } from "node:os";
import { join } from "node:path";

const LABEL = "sh.lucre.decide";

/**
 * Print install steps for a launchd timer that runs pre-market decide (ET).
 * Does not sudo — owner copies the plist themselves.
 */
export function printLaunchdInstall(): void {
  const lucreBin =
    process.env.LUCRE_BIN?.trim() ||
    join(homedir(), ".local/bin/lucre");
  const tokens = join(homedir(), ".tokens");
  const logDir = join(homedir(), ".lucre", "logs");
  const plistPath = join(
    homedir(),
    "Library/LaunchAgents",
    `${LABEL}.plist`,
  );

  // 12:30 UTC ≈ 07:30 ET (EST); owner should adjust for DST (11:30 UTC in EDT)
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>-lc</string>
    <string>set -a; source "${tokens}" 2>/dev/null; set +a; "${lucreBin}" decide --brain bedrock &gt;&gt; "${logDir}/decide.log" 2&gt;&amp;1</string>
  </array>
  <key>StartCalendarInterval</key>
  <array>
    <!-- Weekdays 07:30 America/New_York ≈ 12:30 UTC (EST) / 11:30 UTC (EDT).
         Using 12:30 UTC Mon–Fri; tweak if you're in EDT peak season. -->
    <dict>
      <key>Weekday</key><integer>1</integer>
      <key>Hour</key><integer>12</integer>
      <key>Minute</key><integer>30</integer>
    </dict>
    <dict>
      <key>Weekday</key><integer>2</integer>
      <key>Hour</key><integer>12</integer>
      <key>Minute</key><integer>30</integer>
    </dict>
    <dict>
      <key>Weekday</key><integer>3</integer>
      <key>Hour</key><integer>12</integer>
      <key>Minute</key><integer>30</integer>
    </dict>
    <dict>
      <key>Weekday</key><integer>4</integer>
      <key>Hour</key><integer>12</integer>
      <key>Minute</key><integer>30</integer>
    </dict>
    <dict>
      <key>Weekday</key><integer>5</integer>
      <key>Hour</key><integer>12</integer>
      <key>Minute</key><integer>30</integer>
    </dict>
  </array>
  <key>RunAtLoad</key>
  <false/>
  <key>StandardOutPath</key>
  <string>${logDir}/launchd.out.log</string>
  <key>StandardErrorPath</key>
  <string>${logDir}/launchd.err.log</string>
</dict>
</plist>
`;

  console.log(`# lucre launchd agent — pre-market decide (no --execute by default)

# 1. Ensure CLI is built and linked
cd ~/.superset/projects/lucre && pnpm build
mkdir -p ~/.local/bin ~/.lucre/logs
ln -sfn "$PWD/apps/agent/dist/index.js" ~/.local/bin/lucre
chmod +x apps/agent/dist/index.js

# 2. Write plist
mkdir -p ~/Library/LaunchAgents
cat > "${plistPath}" << 'PLIST'
${plist}
PLIST

# 3. Load
launchctl unload "${plistPath}" 2>/dev/null
launchctl load "${plistPath}"
launchctl list | grep lucre || true

# 4. Manual test
lucre decide --brain bedrock

# 5. When you trust it to place paper orders, edit ProgramArguments to add --execute
#    or run a second agent. Prefer watching logs first:
tail -f ~/.lucre/logs/decide.log

# Notes
# - Sources ~/.tokens for Alpaca + AWS_BEARER_TOKEN_BEDROCK
# - Does NOT --execute by default (WAIT/decide only; safe)
# - Adjust UTC hour for EDT (use 11 instead of 12) if opens miss
# - Uninstall: launchctl unload ${plistPath} && rm ${plistPath}
`);
}
