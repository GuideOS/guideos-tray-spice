const Applet = imports.ui.applet;
const PopupMenu = imports.ui.popupMenu;
const St = imports.gi.St;
const Settings = imports.ui.settings;
const Util = imports.misc.util;
const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const Gtk = imports.gi.Gtk;
const Mainloop = imports.mainloop;

const UUID = "guideos-tray@guideos";

const Updates = imports.ui.appletManager.applets[UUID].updates.Updates;

function unpackPackageSignal(params) {
    let unpacked;
    try {
        unpacked = params.deep_unpack();
    } catch (e) {
        global.logWarning(`${UUID}: deep_unpack failed: ${e}`);
        return;
    }

    // Normalize to an array of [info, pkgid, summary]
    let tuples = [];

    // Cases seen:
    // 1) Package signal: [info, pkgid, summary]
    // 2) Packages signal: [[ [info, pkgid, summary], ... ]]
    // 3) Some variants: [ [info, pkgid, summary], ... ]
    if (unpacked.length === 3 &&
        typeof unpacked[0] === 'number' &&
        typeof unpacked[1] === 'string') {
        tuples.push(unpacked);
    } else if (unpacked.length === 1 &&
        Array.isArray(unpacked[0]) &&
        Array.isArray(unpacked[0][0])) {
        tuples = unpacked[0];
    } else if (unpacked.length &&
        Array.isArray(unpacked[0]) &&
        unpacked[0].length === 3) {
        tuples = unpacked;
    } else {
        global.logWarning(`${UUID}: Unrecognized Package(s) payload shape: ` + JSON.stringify(unpacked));
        return;
    }

    return tuples;
}

const RefreshMode = Object.freeze({
    UPDATES: 'updates',
    PACKAGES: 'packages'
});

function UpdatesNotifier(metadata, orientation, panel_height, instance_id) {
    this._init(metadata, orientation, panel_height, instance_id);
}

UpdatesNotifier.prototype = {
    __proto__: Applet.TextIconApplet.prototype,

    _init: function (metadata, orientation, panel_height, instance_id) {

        this.applet_path = metadata.path;

        Applet.TextIconApplet.prototype._init.call(this, orientation, panel_height, instance_id);

        this.menuManager = new PopupMenu.PopupMenuManager(this);
        this.menu = new Applet.AppletPopupMenu(this, orientation);
        this.menuManager.addMenu(this.menu);

        if (!GLib.find_program_in_path("gnome-terminal")) {
            this.hide_applet_icon(true);
            this.hide_applet_label(false);
            this.set_applet_label("Fehlende Abhängigkeiten");
            return;
        }

        this.uuid = metadata.uuid;
        this.settings = new Settings.AppletSettings(this, metadata.uuid, instance_id);

        this.settings.bind("update-refresh", "refreshTimeout", this._set_check_interval, null);
        this.settings.bind("hide-applet", "hideApplet", this._update, null);

        this.settings.bind("different-levels", "differentLevels", this._update, null);
        this.settings.bind("level-1", "level1", this._update, null);
        this.settings.bind("level-2", "level2", this._update, null);

        this.settings.bind("refresh-when-no-updates", "refreshWhenNoUpdates", this._update, null);
        this.settings.bind("show-firmware", "showFirmware", () => this._refreshUpdatesInfo(RefreshMode.UPDATES, true), null);
        this.settings.bind("show-window-on-click", "showWindowOnClick", this._update, null);
        this.settings.bind("commandUpdate-show", "commandUpdateShow", this._update, null);
        this.settings.bind("commandUpgrade", "commandUpgrade", null, null);
        this.settings.bind("commandUpgrade-show", "commandUpgradeShow", this._update, null);

        this.settings.bind("icon-style", "icon_style", this._update, null);
        this.settings.bind("show-label", "show_label", this._update, null);
        this.settings.bind("label-font-size", "labelFontSize", this._update, null);
        this.settings.bind("label-font-weight", "labelFontWeight", this._update, null);
        this.settings.bind("label-vertical-position", "labelVerticalPosition", this._update, null);

        this.rightMenuItemsIndexes = new Array();

        this.hide_applet_label(true);
        
        // Set icon theme path to our icons directory
        let iconTheme = Gtk.IconTheme.get_default();
        iconTheme.append_search_path(this.applet_path + '/icons');
        
        this.set_applet_icon_name('guideos-tray');

        this.updates = new Updates();
        this.checkingInProgress = false;
        this.pendingUpdate = false;
        this.lastRefreshTime = 0;
        this.lastNotifiedUpdateCount = 0;

        this.hasFirmwareUpdates = false;

        this.interval = null;

        this.bus = Gio.bus_get_sync(Gio.BusType.SYSTEM, null);

        this._watch_dbus();
        this._set_check_interval();
        this._refreshUpdatesInfo();
    },

    _saveUpdatesToFile: function () {
        try {
            // Use a writable location in the user's home directory
            let cacheDir = GLib.get_user_cache_dir() + '/guideos-tray';
            GLib.mkdir_with_parents(cacheDir, 0o755);
            let updatesFile = cacheDir + '/updates';
            
            if (!GLib.file_set_contents(updatesFile, this.updates.toStr())) {
                global.logError(`${UUID}: Failed to write updates file`);
            }
        } catch (e) {
            global.logError(`${UUID}: Error saving updates file: ${e}`);
        }
    },

    _watch_dbus: function () {
        this.package_subscription = this.bus.signal_subscribe(
            'org.freedesktop.PackageKit',
            'org.freedesktop.PackageKit.Transaction',
            null,
            null,
            null,
            Gio.DBusSignalFlags.NONE,
            (_conn, _sender, _path, _iface, signal, params) => {
                if (!this.checkingInProgress) {
                    return;
                }

                if (signal === 'Package' || signal === 'Packages') {
                    for (let t of unpackPackageSignal(params)) {
                        let [info, pkgid, summary] = t;
                        if (this.updates.add(info, pkgid, summary)) {
                            this.pendingUpdate = true;
                        }
                    }
                } else if (signal == "Finished") {
                    if (!this.pendingUpdate) {
                        return;
                    }
                    this.pendingUpdate = false;
                    global.log(`${UUID}: D-Bus Finished signal received, current updates: ${this.updates.map.size}`);
                    this._update();
                    this._saveUpdatesToFile();
                    // Send notification only if update count increased (new updates available)
                    if (this.updates.map.size > 0 && this.updates.map.size > this.lastNotifiedUpdateCount) {
                        this.lastNotifiedUpdateCount = this.updates.map.size;
                        Util.spawn_async(['/usr/bin/bash', this.applet_path + '/updates.sh', "notify", this.updates.map.size.toString()]);
                    } else if (this.updates.map.size === 0) {
                        // Reset counter when no updates available
                        this.lastNotifiedUpdateCount = 0;
                    }
                }
            }
        );

        this.update_changed_subscription = this.bus.signal_subscribe(
            'org.freedesktop.PackageKit',
            'org.freedesktop.PackageKit',
            'UpdatesChanged',
            '/org/freedesktop/PackageKit',
            null,
            Gio.DBusSignalFlags.NONE,
            (_conn, _sender, _path, _iface, signal, params) => {
                // refresh only list of packages, since this was external trigger
                this._refreshUpdatesInfo(RefreshMode.PACKAGES);
            }
        );
    },

    _apply_applet_icon: function (icon_name) {
        // Use GuideOS icons directly without modification
        this.set_applet_icon_name(icon_name);
    },

    _set_check_interval: function () {
        let parsedMinutes = parseInt(this.refreshTimeout);
        if (isNaN(parsedMinutes) || parsedMinutes < 1) {
            this.refreshTimeout = "60";
            parsedMinutes = 60;
        }
        const milis = parsedMinutes * 60 * 1000;

        if (this.interval) {
            Util.clearInterval(this.interval);
        }
        this.interval = Util.setInterval(() => {
            this._refreshUpdatesInfo();
        }, milis);
    },

    _buildMenu: function (count) {
        this.menu.removeAll();
        let items = this._applet_context_menu._getMenuItems();
        for (let i = 0; i < this.rightMenuItemsIndexes.length; i++) {
            if (items[i] instanceof PopupMenu.PopupSeparatorMenuItem || this.rightMenuItemsIndexes.includes(i)) {
                items[i].destroy();
            }
        }
        this.rightMenuItemsIndexes = new Array();
        let position = 0;

        // Only the three menu items
        let iPrimo = new PopupMenu.PopupIconMenuItem("Primo öffnen", "applications-system-symbolic", St.IconType.SYMBOLIC);
        iPrimo.connect('activate', () => {
            Util.spawn_async(['primo-di-tutto']);
        });

        let iReportError = new PopupMenu.PopupIconMenuItem("Fehler melden", "dialog-error-symbolic", St.IconType.SYMBOLIC);
        iReportError.connect('activate', () => {
            Util.spawn(['guideos-ticket-tool']);
        });

        let iOpenUpdater = new PopupMenu.PopupIconMenuItem("Updater öffnen", "software-update-available-symbolic", St.IconType.SYMBOLIC);
        iOpenUpdater.connect('activate', () => {
            Util.spawn(['guideos-updater']);
        });

        if (!this.showWindowOnClick) {
            this.menu.addMenuItem(iPrimo);
            this.menu.addMenuItem(iReportError);
            this.menu.addMenuItem(iOpenUpdater);
        } else {
            this._applet_context_menu.addMenuItem(iPrimo, position);
            this.rightMenuItemsIndexes.push(position++);
            this._applet_context_menu.addMenuItem(iReportError, position);
            this.rightMenuItemsIndexes.push(position++);
            this._applet_context_menu.addMenuItem(iOpenUpdater, position);
            this.rightMenuItemsIndexes.push(position++);
        }
    },

    _update: function () {
        const count = this.updates.map.size;

        this.set_applet_enabled(!this.hideApplet || count != 0);
        const tooltip = count > 0
            ? `${count} Aktualisierungen verfügbar`
            : "Keine Aktualisierungen verfügbar";
        this.set_applet_tooltip(tooltip);

        // Simple logic: no updates = guideos-tray, updates available = guideos-tray-update
        if (count <= 0) {
            this._apply_applet_icon("guideos-tray");
        } else {
            this._apply_applet_icon("guideos-tray-update");
        }

        let fontWeight = `font-weight: ${this.labelFontWeight}`;
        let fontSize = `font-size: ${this.labelFontSize}%`;
        let margin = `margin-${this.labelVerticalPosition > 0 ? "top" : "bottom"}: ${Math.abs(this.labelVerticalPosition)}px`;
        this._applet_label.set_style(`${fontWeight}; ${fontSize}; ${margin}`);

        this._buildMenu(count);
    },

    on_applet_clicked: function () {
        this.menu.toggle();
    },

    _refreshUpdatesInfo: function (refreshMode = RefreshMode.UPDATES, force = false) {
        if (this.checkingInProgress) {
            return;
        }
        if (!force && this.lastRefreshTime && ((GLib.get_monotonic_time() - this.lastRefreshTime) < 5 * GLib.USEC_PER_SEC)) {
            global.log(`${UUID}: Skipping refresh, too frequent`);
            return;
        }

        global.log(`${UUID}: Refreshing ${refreshMode} info...`);
        // Keep the current icon during refresh (don't change to 'configure')
        this.updates = new Updates();

        // accept updates changes only when originating from this applet
        this.checkingInProgress = true;
        Util.spawn_async(['/usr/bin/bash', this.applet_path + '/updates.sh', "check", refreshMode], (stdout) => {
            this.lastRefreshTime = GLib.get_monotonic_time();
            if (this.showFirmware) {
                let fwCount = 0;
                for (let line of stdout.trim().split("\n")) {
                    const tokens = line.split('#');
                    if (tokens.length < 5) {
                        continue;
                    }
                    global.log(`${UUID}: found firmware update: ${line}`);
                    const [name, deviceid, localVersion, version, description] = tokens.map(t => t.trim());
                    this.updates.addFirmware(name, deviceid, localVersion, version, description);
                    fwCount++;
                }

                global.log(`${UUID}: Firmware updates processing finished, updates found: ${fwCount}`);
                this.hasFirmwareUpdates = fwCount > 0;

                if (this.hasFirmwareUpdates) {
                    this._saveUpdatesToFile();
                }
                this._update();
            }

            this.checkingInProgress = false;
            // dbus not fired when no updates - refresh icon manually
            if (this.updates.map.size === 0) {
                this._update();
            }
        });
    },
};

function main(metadata, orientation, panel_height, instance_id) {
    return new UpdatesNotifier(metadata, orientation, panel_height, instance_id);
}
