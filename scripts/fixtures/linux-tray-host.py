"""Controlled StatusNotifier host on the audit's isolated session bus."""
import json
import os
import sys
from gi.repository import Gio, GLib

output = sys.argv[1]
items = []
interface = "org.kde.StatusNotifierWatcher"
xml = """<node><interface name="org.kde.StatusNotifierWatcher">
<method name="RegisterStatusNotifierItem"><arg type="s" direction="in"/></method>
<method name="RegisterStatusNotifierHost"><arg type="s" direction="in"/></method>
<property name="RegisteredStatusNotifierItems" type="as" access="read"/>
<property name="IsStatusNotifierHostRegistered" type="b" access="read"/>
<property name="ProtocolVersion" type="i" access="read"/>
<signal name="StatusNotifierItemRegistered"><arg type="s"/></signal>
<signal name="StatusNotifierItemUnregistered"><arg type="s"/></signal>
<signal name="StatusNotifierHostRegistered"/>
</interface></node>"""
connection = Gio.bus_get_sync(Gio.BusType.SESSION, None)


def record():
    with open(output + ".tmp", "w", encoding="utf-8") as target:
        json.dump({"ready": True, "items": items}, target)
    os.replace(output + ".tmp", output)


def method(bus, sender, path, iface, name, parameters, invocation):
    if name == "RegisterStatusNotifierItem":
        value = parameters.unpack()[0]
        item = {"service": sender if value.startswith("/") else value,
                "path": value if value.startswith("/") else "/StatusNotifierItem"}
        if item not in items:
            items.append(item)
            record()
        bus.emit_signal(None, path, interface, "StatusNotifierItemRegistered",
                        GLib.Variant("(s)", (item["service"] + item["path"],)))
    invocation.return_value(None)


def property_value(bus, sender, path, iface, name):
    if name == "IsStatusNotifierHostRegistered":
        return GLib.Variant("b", True)
    if name == "ProtocolVersion":
        return GLib.Variant("i", 0)
    return GLib.Variant("as", [item["service"] + item["path"] for item in items])


connection.register_object("/StatusNotifierWatcher", Gio.DBusNodeInfo.new_for_xml(xml).interfaces[0], method, property_value, None)
Gio.bus_own_name_on_connection(connection, interface, Gio.BusNameOwnerFlags.NONE,
                               lambda *_: record(), lambda *_: sys.exit("Audit bus name unavailable"))
GLib.MainLoop().run()
