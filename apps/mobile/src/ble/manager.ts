import { BleManager } from "react-native-ble-plx";

/** One BleManager for the whole app lifetime — react-native-ble-plx expects a singleton. */
export const bleManager = new BleManager();
