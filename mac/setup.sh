#!/bin/bash
# STREAK-TENDO Mac setup. Run once with:  bash ~/Downloads/setup.sh
BASE="$HOME/streaktendo"
HERE="$(cd "$(dirname "$0")" && pwd)"
PLIST="$HOME/Library/LaunchAgents/com.streaktendo.daily.plist"

if ! xcode-select -p >/dev/null 2>&1; then
  echo "Installing Apple's Command Line Tools (needed for git and python3)."
  echo "A window will open. Click Install, wait for it to finish, then run this script again."
  xcode-select --install
  exit 1
fi
if [ ! -f "$HERE/streaktendo.py" ]; then
  echo "Put streaktendo.py in the same folder as this script ($HERE) and run again."; exit 1
fi

mkdir -p "$BASE/logs" "$HOME/Library/LaunchAgents"
cp "$HERE/streaktendo.py" "$BASE/streaktendo.py"

if [ ! -d "$BASE/streaktendo.github.io/.git" ]; then
  echo "Downloading your US website repo..."
  git clone -q https://github.com/streaktendo/streaktendo.github.io.git "$BASE/streaktendo.github.io" || { echo "Clone failed."; exit 1; }
fi
git -C "$BASE/streaktendo.github.io" config user.name "STREAK-TENDO Mac"
git -C "$BASE/streaktendo.github.io" config user.email "streaktendo@users.noreply.github.com"
git -C "$BASE/streaktendo.github.io" config credential.helper osxkeychain

cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.streaktendo.daily</string>
  <key>ProgramArguments</key>
  <array><string>/usr/bin/python3</string><string>$BASE/streaktendo.py</string></array>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>9</integer><key>Minute</key><integer>15</integer></dict>
  <key>StandardOutPath</key><string>$BASE/logs/launchd.log</string>
  <key>StandardErrorPath</key><string>$BASE/logs/launchd.log</string>
</dict>
</plist>
PL
launchctl unload "$PLIST" 2>/dev/null
launchctl load "$PLIST"

echo
echo "Set up. The reader will run every day at 9:15 AM."
echo "Next, test it with:   python3 ~/streaktendo/streaktendo.py --dry-run"
