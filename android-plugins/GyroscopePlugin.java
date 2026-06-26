package com.sharpmobile.app;

import android.app.Activity;
import android.content.pm.ActivityInfo;
import android.content.Context;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "Gyroscope")
public class GyroscopePlugin extends Plugin implements SensorEventListener {
    private SensorManager sensorManager;
    private Sensor rotationSensor;
    private Sensor accelerometer;
    private Sensor magnetometer;
    private float[] gravityValues;
    private float[] geomagneticValues;
    private boolean isListening = false;

    @Override
    public void load() {
        sensorManager = (SensorManager) getContext().getSystemService(Context.SENSOR_SERVICE);
        // Try game rotation vector first (uses accelerometer + gyro, no magnetometer needed)
        rotationSensor = sensorManager.getDefaultSensor(Sensor.TYPE_GAME_ROTATION_VECTOR);
        if (rotationSensor == null) {
            // Fall back to accelerometer + magnetometer
            accelerometer = sensorManager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER);
            magnetometer = sensorManager.getDefaultSensor(Sensor.TYPE_MAGNETIC_FIELD);
        }
    }

    @PluginMethod
    public void start(PluginCall call) {
        if (isListening) {
            call.resolve();
            return;
        }
        if (rotationSensor != null) {
            sensorManager.registerListener(this, rotationSensor, SensorManager.SENSOR_DELAY_GAME);
            isListening = true;
            JSObject result = new JSObject();
            result.put("started", true);
            result.put("method", "game_rotation_vector");
            call.resolve(result);
        } else if (accelerometer != null && magnetometer != null) {
            sensorManager.registerListener(this, accelerometer, SensorManager.SENSOR_DELAY_GAME);
            sensorManager.registerListener(this, magnetometer, SensorManager.SENSOR_DELAY_GAME);
            isListening = true;
            JSObject result = new JSObject();
            result.put("started", true);
            result.put("method", "accel_mag");
            call.resolve(result);
        } else {
            JSObject result = new JSObject();
            result.put("started", false);
            result.put("method", "none");
            result.put("error", "No suitable sensors found");
            call.resolve(result);
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        if (isListening) {
            sensorManager.unregisterListener(this);
            isListening = false;
        }
        call.resolve();
    }

    @PluginMethod
    public void lockLandscape(PluginCall call) {
        Activity activity = getActivity();
        if (activity != null) {
            activity.setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE);
        }
        call.resolve();
    }

    @PluginMethod
    public void lockPortrait(PluginCall call) {
        Activity activity = getActivity();
        if (activity != null) {
            activity.setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT);
        }
        call.resolve();
    }

    @PluginMethod
    public void unlockOrientation(PluginCall call) {
        Activity activity = getActivity();
        if (activity != null) {
            activity.setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_FULL_SENSOR);
        }
        call.resolve();
    }

    @Override
    public void onSensorChanged(SensorEvent event) {
        if (event.sensor.getType() == Sensor.TYPE_GAME_ROTATION_VECTOR) {
            float[] rotationMatrix = new float[9];
            try {
                SensorManager.getRotationMatrixFromVector(rotationMatrix, event.values);
            } catch (Exception e) {
                return;
            }
            float[] orientationValues = new float[3];
            SensorManager.getOrientation(rotationMatrix, orientationValues);
            sendOrientation(orientationValues);
        } else if (event.sensor.getType() == Sensor.TYPE_ACCELEROMETER) {
            gravityValues = event.values;
            tryComputeOrientation();
        } else if (event.sensor.getType() == Sensor.TYPE_MAGNETIC_FIELD) {
            geomagneticValues = event.values;
            tryComputeOrientation();
        }
    }

    private void tryComputeOrientation() {
        if (gravityValues != null && geomagneticValues != null) {
            float[] rotationMatrix = new float[9];
            float[] orientationValues = new float[3];
            boolean success = SensorManager.getRotationMatrix(rotationMatrix, null, gravityValues, geomagneticValues);
            if (success) {
                SensorManager.getOrientation(rotationMatrix, orientationValues);
                sendOrientation(orientationValues);
            }
        }
    }

    private void sendOrientation(float[] orientationValues) {
        float azimuth = (float) Math.toDegrees(orientationValues[0]);
        float pitch = (float) Math.toDegrees(orientationValues[1]);
        float roll = (float) Math.toDegrees(orientationValues[2]);

        JSObject data = new JSObject();
        data.put("alpha", (double) azimuth);
        data.put("beta", (double) pitch);
        data.put("gamma", (double) roll);

        notifyListeners("orientation", data);
    }

    @Override
    public void onAccuracyChanged(Sensor sensor, int accuracy) {}
}
