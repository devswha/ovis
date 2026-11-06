package sh.ovis.app;

import android.content.ClipData;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.MediaStore;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;

/**
 * Download in the chat's image viewer (src/lib/saveImage.ts). The WebView has no download handler
 * and no Web Share, so a download link did nothing (#3153). The page hands the picture's bytes over
 * instead, already read through its own transport (a relay PC's blob: pictures, a PC's signed-in
 * file route), and the picture lands in Downloads, as a download in Chrome does. Android 8 and 9
 * write to Downloads only with the storage permission, which the app does not ask for: there the
 * picture goes to the share sheet.
 */
@CapacitorPlugin(name = "OvisSave")
public class SaveImagePlugin extends Plugin {
    /** name, type (image/*) and data (base64). Resolves `saved`: "downloads", or "shared" for the share sheet. */
    @PluginMethod
    public void saveImage(PluginCall call) {
        String type = call.getString("type");
        if (!SavedImage.isImageType(type)) {
            call.reject("Only a picture can be saved.");
            return;
        }
        byte[] bytes = SavedImage.decode(call.getString("data"));
        if (bytes == null) {
            call.reject("The picture is empty, too large or not base64.");
            return;
        }
        String name = SavedImage.fileName(call.getString("name"));
        try {
            JSObject result = new JSObject();
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                toDownloads(name, type, bytes);
                result.put("saved", "downloads");
            } else {
                toShareSheet(name, type, bytes);
                result.put("saved", "shared");
            }
            call.resolve(result);
        } catch (IOException | RuntimeException failed) {
            call.reject("The picture could not be saved.", failed);
        }
    }

    private void toDownloads(String name, String type, byte[] bytes) throws IOException {
        ContentResolver resolver = getContext().getContentResolver();
        ContentValues values = new ContentValues();
        values.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
        values.put(MediaStore.MediaColumns.MIME_TYPE, type);
        // hidden from other apps until it is whole
        values.put(MediaStore.MediaColumns.IS_PENDING, 1);
        Uri uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
        if (uri == null) throw new IOException("Downloads refused the picture");
        try {
            try (OutputStream out = resolver.openOutputStream(uri)) {
                if (out == null) throw new IOException("Downloads gave nothing to write to");
                out.write(bytes);
            }
            values.clear();
            values.put(MediaStore.MediaColumns.IS_PENDING, 0);
            resolver.update(uri, values, null, null);
        } catch (IOException | RuntimeException failed) {
            resolver.delete(uri, null, null);
            throw failed;
        }
    }

    private void toShareSheet(String name, String type, byte[] bytes) throws IOException {
        // the one picture last shared: res/xml/file_paths.xml shares this folder and nothing else
        File folder = new File(getContext().getCacheDir(), "saved");
        File[] earlier = folder.listFiles();
        if (earlier != null) for (File file : earlier) file.delete();
        if (!folder.isDirectory() && !folder.mkdirs()) throw new IOException("no folder for the picture");
        File file = new File(folder, name);
        try (OutputStream out = new FileOutputStream(file)) {
            out.write(bytes);
        }
        Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", file);
        Intent send = new Intent(Intent.ACTION_SEND)
            .setType(type)
            .putExtra(Intent.EXTRA_STREAM, uri)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        send.setClipData(ClipData.newRawUri(name, uri));
        getActivity().runOnUiThread(() -> getActivity().startActivity(Intent.createChooser(send, null)));
    }
}
