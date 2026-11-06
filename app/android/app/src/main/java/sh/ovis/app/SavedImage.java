package sh.ovis.app;

import java.util.Base64;

/** What SaveImagePlugin takes from a page, checked before anything is written. */
final class SavedImage {
    /** Far above any chat picture, and below what a phone's WebView can hand over in one call. */
    static final int MAX_BYTES = 50 * 1024 * 1024;

    private static final int MAX_NAME = 120;

    private SavedImage() {}

    static boolean isImageType(String type) {
        return type != null && type.matches("image/[A-Za-z0-9.+-]+");
    }

    /** The bytes of base64 `data`, or null when it is missing, empty, not base64 or over MAX_BYTES. */
    static byte[] decode(String data) {
        if (data == null || data.isEmpty() || data.length() / 4 * 3 > MAX_BYTES + 3) return null;
        try {
            byte[] bytes = Base64.getDecoder().decode(data);
            return bytes.length == 0 || bytes.length > MAX_BYTES ? null : bytes;
        } catch (IllegalArgumentException notBase64) {
            return null;
        }
    }

    /**
     * `name`'s last path part, without characters a file name in Downloads cannot hold or a leading
     * dot (a hidden file), cut to MAX_NAME; "image" when nothing is left.
     */
    static String fileName(String name) {
        String last = name == null ? "" : name.substring(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1);
        String clean = last.replaceAll("[\\p{Cntrl}:*?\"<>|]", "").trim().replaceFirst("^\\.+", "");
        if (clean.length() > MAX_NAME) {
            int dot = clean.lastIndexOf('.');
            String extension = dot > 0 && clean.length() - dot <= 10 ? clean.substring(dot) : "";
            clean = clean.substring(0, MAX_NAME - extension.length()) + extension;
        }
        return clean.isEmpty() ? "image" : clean;
    }
}
