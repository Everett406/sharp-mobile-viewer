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
            rotationSensor = sensorManager.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR);
        }
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
            String method = (rotationSensor.getType() == Sensor.TYPE_GAME_ROTATION_VECTOR)
                    ? "game_rotation_vector" : "rotation_vector";
            result.put("method", method);
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

    @Override
    public void onSensorChanged(SensorEvent event) {
        if (event.sensor.getType() == Sensor.TYPE_GAME_ROTATION_VECTOR
                || event.sensor.getType() == Sensor.TYPE_ROTATION_VECTOR) {
            // Send quaternion directly — no Euler angle gimbal lock issues
            float[] quaternion = new float[4];
            try {
                // event.values for rotation vector: [x, y, z, w] (or [x, y, z] if w is not available)
                if (event.values.length >= 4) {
                    System.arraycopy(event.values, 0, quaternion, 0, 4);
                } else {
                    // For older API levels where w is not included
                    SensorManager.getQuaternionFromVector(quaternion, event.values);
                }
            } catch (Exception e) {
                return;
            }

            JSObject data = new JSObject();
            data.put("qx", (double) quaternion[0]);
            data.put("qy", (double) quaternion[1]);
            data.put("qz", (double) quaternion[2]);
            data.put("qw", (double) quaternion[3]);
            notifyListeners("orientation", data);

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
            boolean success = SensorManager.getRotationMatrix(rotationMatrix, null, gravityValues, geomagneticValues);
            if (success) {
                float[] quaternion = new float[4];
                // Convert rotation matrix to quaternion
                quaternion[0] = (float) (0.5 * Math.sqrt(Math.max(0, 1 + rotationMatrix[0] - rotationMatrix[4] - rotationMatrix[8])) * Math.signum(rotationMatrix[7] - rotationMatrix[5]));
                quaternion[1] = (float) (0.5 * Math.sqrt(Math.max(0, 1 - rotationMatrix[0] + rotationMatrix[4] - rotationMatrix[8])) * Math.signum(rotationMatrix[2] - rotationMatrix[6]));
                quaternion[2] = (float) (0.5 * Math.sqrt(Math.max(0, 1 - rotationMatrix[0] - rotationMatrix[4] + rotationMatrix[8])) * Math.signum(rotationMatrix[3] - rotationMatrix[1]));
                quaternion[3] = (float) (0.5 * Math.sqrt(Math.max(0, 1 + rotationMatrix[0] + rotationMatrix[4] + rotationMatrix[8])));

                JSObject data = new JSObject();
                data.put("qx", (double) quaternion[0]);
                data.put("qy", (double) quaternion[1]);
                data.put("qz", (double) quaternion[2]);
                data.put("qw", (double) quaternion[3]);
                notifyListeners("orientation", data);
            }
        }
    }

    @Override
    public void onAccuracyChanged(Sensor sensor, int accuracy) {}
}
