#!/bin/sh
LABEL=dev.herdr.web
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
echo "Herdr Web stopped and removed from login items."
