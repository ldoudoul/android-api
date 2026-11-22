package com.lightchat.app;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Matrix;
import android.media.ExifInterface;
import android.media.MediaMetadataRetriever;
import android.net.Uri;
import android.util.Base64;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.util.UUID;

final class MediaFiles {

    static final long MAX_IMAGE_BYTES = 5L * 1024 * 1024;
    static final long MAX_VIDEO_BYTES = 8L * 1024 * 1024;

    private static final int MAX_DIM = 1568;
    private static final int THUMB_DIM = 144;

    private MediaFiles() {
    }

    static final class Item {
        String id;
        String type;
        String mime;
        String name;
        String thumb;
        long size;
    }

    static File dir(Context ctx) {
        File d = new File(ctx.getFilesDir(), "media");
        if (!d.exists()) d.mkdirs();
        return d;
    }

    static File find(Context ctx, String id) {
        if (id == null || !id.matches("[A-Za-z0-9_-]{1,40}")) return null;
        File[] files = dir(ctx).listFiles();
        if (files == null) return null;
        for (File f : files) {
            String n = f.getName();
            if (n.startsWith(id + ".")) return f;
        }
        return null;
    }

    static void delete(Context ctx, String id) {
        File f = find(ctx, id);
        if (f != null) f.delete();
    }

    static Item addImage(Context ctx, Uri uri, String name) {
        try {
            BitmapFactory.Options bounds = new BitmapFactory.Options();
            bounds.inJustDecodeBounds = true;
            InputStream in = ctx.getContentResolver().openInputStream(uri);
            if (in == null) return null;
            BitmapFactory.decodeStream(in, null, bounds);
            in.close();
            if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null;

            int sample = 1;
            while (Math.max(bounds.outWidth, bounds.outHeight) / (sample * 2) > MAX_DIM) sample *= 2;

            BitmapFactory.Options opts = new BitmapFactory.Options();
            opts.inSampleSize = sample;
            in = ctx.getContentResolver().openInputStream(uri);
            if (in == null) return null;
            Bitmap bmp = BitmapFactory.decodeStream(in, null, opts);
            in.close();
            if (bmp == null) return null;

            int rotation = readRotation(ctx, uri);
            Bitmap scaled = scaleDown(bmp, MAX_DIM, rotation);
            if (scaled != bmp) bmp.recycle();
            bmp = scaled;

            byte[] data = compress(bmp, 86);
            if (data.length > MAX_IMAGE_BYTES) data = compress(bmp, 68);
            if (data.length > MAX_IMAGE_BYTES) {
                bmp.recycle();
                return null;
            }
            Bitmap thumbBmp = scaleBitmap(bmp, THUMB_DIM);
            byte[] thumb = compress(thumbBmp, 62);
            if (thumbBmp != bmp) thumbBmp.recycle();
            bmp.recycle();

            Item item = new Item();
            item.id = save(ctx, data, "jpg");
            if (item.id == null) return null;
            item.type = "image";
            item.mime = "image/jpeg";
            item.name = name;
            item.size = data.length;
            item.thumb = "data:image/jpeg;base64," + Base64.encodeToString(thumb, Base64.NO_WRAP);
            return item;
        } catch (Exception e) {
            return null;
        }
    }

    static Item addVideo(Context ctx, Uri uri, String name, String mime) {
        File tmp = new File(dir(ctx), "tmp-" + UUID.randomUUID().toString().replace("-", "") + ".part");
        try {
            InputStream in = ctx.getContentResolver().openInputStream(uri);
            if (in == null) return null;
            FileOutputStream out = new FileOutputStream(tmp);
            byte[] buf = new byte[64 * 1024];
            long total = 0;
            int n;
            while ((n = in.read(buf)) != -1) {
                total += n;
                if (total > MAX_VIDEO_BYTES) {
                    in.close();
                    out.close();
                    tmp.delete();
                    return null;
                }
                out.write(buf, 0, n);
            }
            in.close();
            out.close();

            String ext = "mp4";
            if (mime != null && mime.contains("quicktime")) ext = "mov";
            else if (mime != null && mime.contains("webm")) ext = "webm";
            String id = UUID.randomUUID().toString().replace("-", "").substring(0, 12);
            File dest = new File(dir(ctx), id + "." + ext);
            if (!tmp.renameTo(dest)) {
                tmp.delete();
                return null;
            }

            Item item = new Item();
            item.id = id;
            item.type = "video";
            item.mime = mime == null || mime.isEmpty() ? "video/mp4" : mime;
            item.name = name;
            item.size = total;
            item.thumb = videoThumb(ctx, uri);
            return item;
        } catch (Exception e) {
            tmp.delete();
            return null;
        }
    }

    private static String videoThumb(Context ctx, Uri uri) {
        MediaMetadataRetriever r = new MediaMetadataRetriever();
        try {
            r.setDataSource(ctx, uri);
            Bitmap f = r.getFrameAtTime(1000000L, MediaMetadataRetriever.OPTION_CLOSEST_SYNC);
            if (f == null) f = r.getFrameAtTime(0);
            if (f == null) return "";
            Bitmap t = scaleBitmap(f, THUMB_DIM);
            byte[] b = compress(t, 60);
            f.recycle();
            t.recycle();
            return "data:image/jpeg;base64," + Base64.encodeToString(b, Base64.NO_WRAP);
        } catch (Exception e) {
            return "";
        } finally {
            try {
                r.release();
            } catch (Exception ignored) {
            }
        }
    }

    private static int readRotation(Context ctx, Uri uri) {
        try {
            InputStream in = ctx.getContentResolver().openInputStream(uri);
            if (in == null) return 0;
            ExifInterface exif = new ExifInterface(in);
            int o = exif.getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL);
            in.close();
            if (o == ExifInterface.ORIENTATION_ROTATE_90) return 90;
            if (o == ExifInterface.ORIENTATION_ROTATE_180) return 180;
            if (o == ExifInterface.ORIENTATION_ROTATE_270) return 270;
        } catch (Exception ignored) {
        }
        return 0;
    }

    private static Bitmap scaleDown(Bitmap src, int maxDim, int rotation) {
        try {
            int w = src.getWidth();
            int h = src.getHeight();
            float scale = 1f;
            if (Math.max(w, h) > maxDim) scale = (float) maxDim / Math.max(w, h);
            Matrix m = new Matrix();
            m.postScale(scale, scale);
            if (rotation != 0) m.postRotate(rotation);
            return Bitmap.createBitmap(src, 0, 0, w, h, m, true);
        } catch (Exception e) {
            return src;
        }
    }

    private static Bitmap scaleBitmap(Bitmap src, int maxDim) {
        int w = src.getWidth();
        int h = src.getHeight();
        float scale = Math.min(1f, (float) maxDim / Math.max(w, h));
        if (scale >= 1f) return src;
        return Bitmap.createScaledBitmap(src, Math.max(1, (int) (w * scale)), Math.max(1, (int) (h * scale)), true);
    }

    private static byte[] compress(Bitmap bmp, int quality) {
        Bitmap flat = bmp;
        boolean made = false;
        if (bmp.getConfig() != Bitmap.Config.ARGB_8888 || bmp.hasAlpha()) {
            flat = Bitmap.createBitmap(bmp.getWidth(), bmp.getHeight(), Bitmap.Config.ARGB_8888);
            Canvas c = new Canvas(flat);
            c.drawColor(Color.WHITE);
            c.drawBitmap(bmp, 0, 0, null);
            made = true;
        }
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        flat.compress(Bitmap.CompressFormat.JPEG, quality, bos);
        if (made) flat.recycle();
        return bos.toByteArray();
    }

    private static String save(Context ctx, byte[] data, String ext) {
        String id = UUID.randomUUID().toString().replace("-", "").substring(0, 12);
        File f = new File(dir(ctx), id + "." + ext);
        try {
            FileOutputStream out = new FileOutputStream(f);
            out.write(data);
            out.close();
            return id;
        } catch (Exception e) {
            return null;
        }
    }
}
