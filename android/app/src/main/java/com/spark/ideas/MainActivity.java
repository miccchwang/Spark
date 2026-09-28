package com.spark.ideas;

import android.Manifest;
import android.os.Build;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // registerPlugin must run before super.onCreate(): BridgeActivity builds the bridge
        // inside its own onCreate, and only plugins already queued here get loaded.
        registerPlugin(SpeechPlugin.class);
        super.onCreate(savedInstanceState);
        // Spark records voice and tags it with a location, so ask up front on first launch.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            requestPermissions(
                new String[]{
                    Manifest.permission.RECORD_AUDIO,
                    Manifest.permission.ACCESS_FINE_LOCATION,
                    Manifest.permission.ACCESS_COARSE_LOCATION
                },
                1001
            );
        }
    }
}
