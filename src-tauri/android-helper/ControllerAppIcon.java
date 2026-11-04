import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.drawable.Drawable;
import android.util.Base64;
import java.io.ByteArrayOutputStream;
import java.lang.reflect.Method;

public final class ControllerAppIcon {
    public static void main(String[] args) throws Exception {
        android.os.Looper.prepareMainLooper();
        Class<?> workarounds = Class.forName("com.genymobile.scrcpy.Workarounds");
        workarounds.getMethod("apply").invoke(null);
        java.lang.reflect.Method getContext = workarounds.getDeclaredMethod("getSystemContext");
        getContext.setAccessible(true);
        Context context = (Context) getContext.invoke(null);
        Drawable icon = context.getPackageManager().getApplicationIcon(args[0]);
        Bitmap bitmap = Bitmap.createBitmap(96, 96, Bitmap.Config.ARGB_8888);
        icon.setBounds(0, 0, 96, 96);
        icon.draw(new Canvas(bitmap));
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        if (!bitmap.compress(Bitmap.CompressFormat.PNG, 100, output)) {
            throw new IllegalStateException("Could not encode icon");
        }
        System.out.println("CONTROLLER_ICON " + Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP));
    }
}
