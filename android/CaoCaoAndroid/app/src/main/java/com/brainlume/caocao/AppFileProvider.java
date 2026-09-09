package com.brainlume.caocao;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;

import java.io.File;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.util.Locale;

/** Shares files stored in the app-private Documents directory without file:// URIs. */
public final class AppFileProvider extends ContentProvider {
    private static final String[] COLUMNS = {"_display_name", "_size"};

    @Override public boolean onCreate() { return true; }
    @Override public String getType(Uri uri) {
        String name = fileFor(uri).getName().toLowerCase(Locale.ROOT);
        if (name.endsWith(".png")) return "image/png";
        if (name.endsWith(".pdf")) return "application/pdf";
        if (name.endsWith(".json") || name.endsWith(".jsonl")) return "application/json";
        if (name.endsWith(".edf")) return "application/octet-stream";
        return "application/octet-stream";
    }
    @Override public Cursor query(Uri uri, String[] projection, String selection, String[] selectionArgs, String sortOrder) {
        File file = fileFor(uri);
        MatrixCursor cursor = new MatrixCursor(COLUMNS, 1);
        cursor.addRow(new Object[]{file.getName(), file.length()});
        return cursor;
    }
    @Override public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        if (!"r".equals(mode)) throw new FileNotFoundException("只允许读取共享文件");
        return ParcelFileDescriptor.open(fileFor(uri), ParcelFileDescriptor.MODE_READ_ONLY);
    }
    @Override public int delete(Uri uri, String selection, String[] selectionArgs) { return 0; }
    @Override public Uri insert(Uri uri, ContentValues values) { return null; }
    @Override public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) { return 0; }

    private File fileFor(Uri uri) {
        String path = uri == null ? null : uri.getQueryParameter("path");
        if (path == null || path.trim().isEmpty()) throw new IllegalArgumentException("缺少共享文件路径");
        try {
            File target = new File(path).getCanonicalFile();
            File documents = getContext().getExternalFilesDir(android.os.Environment.DIRECTORY_DOCUMENTS);
            File internal = getContext().getFilesDir();
            String targetPath = target.getPath() + File.separator;
            boolean inDocuments = documents != null && targetPath.startsWith(documents.getCanonicalPath() + File.separator);
            boolean inInternal = targetPath.startsWith(internal.getCanonicalPath() + File.separator);
            if ((!inDocuments && !inInternal) || !target.isFile()) throw new IllegalArgumentException("文件不在应用数据目录中");
            return target;
        } catch (IOException error) {
            throw new IllegalArgumentException("无法解析共享文件", error);
        }
    }
}
