package sh.ovis.widget;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** `OvisWidget.placed()`: whether a widget is on the home screen, so the open PC pushes to it (src/fork/inboxWidget.ts). */
@CapacitorPlugin(name = "OvisWidget")
public class OvisWidgetPlugin extends Plugin {
    @PluginMethod
    public void placed(PluginCall call) {
        JSObject result = new JSObject();
        result.put("placed", InboxWidget.ids(getContext()).length > 0);
        call.resolve(result);
    }
}
