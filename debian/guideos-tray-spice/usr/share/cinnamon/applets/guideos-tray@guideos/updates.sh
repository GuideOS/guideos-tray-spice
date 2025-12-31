#!/usr/bin/env bash

set -u

DIR=$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")
readonly DIR

case "$1" in
check)
    refreshMode=$2

    if [[ "$refreshMode" = "updates" ]]; then
        pkcon refresh &>/dev/null
    fi
    
    pkcon get-updates &>/dev/null
    pkcon get-packages --filter installed &>/dev/null

    if command -v fwupdmgr &>/dev/null && command -v jq &>/dev/null; then
        if [[ "$refreshMode" = "updates" ]]; then
            fwupdmgr refresh &>/dev/null
        fi
        fwupdmgr get-updates --no-authenticate --json 2>/dev/null | jq -r '
            .Devices[]
            | select(.Releases | length > 0)
            | . as $d
            | $d.Releases[]
            | "\($d.Name)#\($d.DeviceId)#\($d.Version)#\(.Version)#\($d.Summary)"
        ' 2>/dev/null
    fi

    sleep 1 # give time for transaction to finish
    ;;
notify)
    # Send desktop notification with update count
    update_count=$2
    
    # Ensure DBUS_SESSION_BUS_ADDRESS is set for notify-send
    if [[ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ]]; then
        user=$(whoami)
        DBUS_SESSION_BUS_ADDRESS=$(grep -z DBUS_SESSION_BUS_ADDRESS /proc/$(pgrep -u "$user" cinnamon | head -1)/environ 2>/dev/null | cut -d= -f2- | tr -d '\0')
        export DBUS_SESSION_BUS_ADDRESS
    fi
    
    # Ensure DISPLAY is set
    if [[ -z "${DISPLAY:-}" ]]; then
        export DISPLAY=:0
    fi
    
    # Check for Flatpak updates
    flatpak_count=0
    if command -v flatpak &>/dev/null; then
        flatpak_count=$(flatpak remote-ls --updates 2>/dev/null | wc -l)
    fi
    
    total_count=$((update_count + flatpak_count))
    
    if command -v notify-send &>/dev/null && [[ "$total_count" -gt 0 ]]; then
        # Build message with package and flatpak counts
        if [[ "$update_count" -gt 0 ]] && [[ "$flatpak_count" -gt 0 ]]; then
            notify_message="$update_count Pakete und $flatpak_count Flatpak-Updates verfügbar"
        elif [[ "$update_count" -gt 0 ]]; then
            if [[ "$update_count" -eq 1 ]]; then
                notify_message="1 Paket-Aktualisierung verfügbar"
            else
                notify_message="$update_count Paket-Aktualisierungen verfügbar"
            fi
        elif [[ "$flatpak_count" -gt 0 ]]; then
            if [[ "$flatpak_count" -eq 1 ]]; then
                notify_message="1 Flatpak-Aktualisierung verfügbar"
            else
                notify_message="$flatpak_count Flatpak-Aktualisierungen verfügbar"
            fi
        fi
        
        # Send notification with action button in background
        (
            action=$(notify-send "GuideOS Updates" "$notify_message" \
                --icon=/usr/share/icons/hicolor/scalable/apps/guidos-updater.svg \
                --action=update="GuideOS-Updater öffnen" \
                --wait \
                --urgency=critical 2>&1)
            
            # If user clicked "Open Updater", launch it
            if [[ "$action" == "update" ]]; then
                python3 /usr/lib/guideos-updater/main.py &
            fi
        ) &
    fi
    ;;
command)
    readonly cmd=$2
    if command -v gsettings &>/dev/null; then
        term=$(gsettings get org.cinnamon.desktop.default-applications.terminal exec | tr -d \')
        termarg=$(gsettings get org.cinnamon.desktop.default-applications.terminal exec-arg | tr -d \')
        if [ -n "$term" ]; then
            args=("$term")
            [ -n "$termarg" ] && args+=("$termarg")
            args+=("/usr/bin/bash" "-c" "$cmd")
            "${args[@]}"
        fi
    fi
    ;;
*)
    exit 1
    ;;
esac
