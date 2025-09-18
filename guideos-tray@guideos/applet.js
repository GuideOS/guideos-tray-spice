const Applet = imports.ui.applet;
const PopupMenu = imports.ui.popupMenu;
const Util = imports.misc.util;
const Gettext = imports.gettext;
Gettext.bindtextdomain("guideos-tray", GLib.build_filenamev(["/usr/share/cinnamon/applets/guideos-tray-spice/locale"]));
const _ = Gettext.gettext;

function FirewallApplet(orientation, panelHeight, instanceId) {
    this._init(orientation, panelHeight, instanceId);
}

FirewallApplet.prototype = {
    __proto__: Applet.IconApplet.prototype,

    _init: function(orientation, panelHeight, instanceId) {
        Applet.IconApplet.prototype._init.call(this, orientation, panelHeight, instanceId);

        // Setze Standard-Icon und Tooltip
        this.set_applet_icon_symbolic_name("guideos-tray");
        this.set_applet_tooltip(_("GuideOS Tray (Click to open menu)"));

        // Erstelle Popup-Menü
        this.menuManager = new PopupMenu.PopupMenuManager(this);
        this.menu = new Applet.AppletPopupMenu(this, orientation);
        this.menuManager.addMenu(this.menu);



        // Menüeintrag: Open Primo
        let primoItem = new PopupMenu.PopupMenuItem(_("Open Primo"));
        primoItem.connect('activate', () => {
            Util.spawn(["primo-di-tutto"]);
        });
        this.menu.addMenuItem(primoItem);

        // Menüeintrag: Report Bug
        let ticketItem = new PopupMenu.PopupMenuItem(_("Report Bug"));
        ticketItem.connect('activate', () => {
            Util.spawn(["guideos-ticket-tool"]);
        });
        this.menu.addMenuItem(ticketItem);

        // Menüeintrag: Update System
        let updaterItem = new PopupMenu.PopupMenuItem(_("Update System"));
        updaterItem.connect('activate', () => {
            Util.spawn(["guideos-updater"]);
        });
        this.menu.addMenuItem(updaterItem);
    },

    on_applet_clicked: function(event) {
        this.menu.toggle();
    },

    on_applet_removed_from_panel: function() {
        // Hier ggf. Aufräumarbeiten
    },

    get_applet_info: function() {
        return "GuideOS Tools Applet v1.0";
    }
};

function main(metadata, orientation, panelHeight, instanceId) {
    return new FirewallApplet(orientation, panelHeight, instanceId);
}