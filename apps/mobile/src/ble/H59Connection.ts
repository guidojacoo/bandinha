import type { Device, Subscription } from "react-native-ble-plx";
import * as Protocol from "@h59/protocol";
import type { DeviceCapabilities } from "@h59/shared";
import { bleManager } from "./manager";
import { bytesToBase64, base64ToBytes } from "./base64";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type FrameListener = (frame: Uint8Array) => void;
type BcFrameListener = (frame: Protocol.ParsedBcFrame) => void;

/**
 * The mobile equivalent of OpenH59's `Band` class: owns one connected H59,
 * speaks the protocol via @h59/protocol (never hand-rolls bytes here), and
 * exposes high-level async methods. All request/response collection is
 * client-side timing logic — the wire format itself comes entirely from the
 * shared protocol package, so this file has no protocol knowledge baked in.
 */
export class H59Connection {
  private device: Device;
  private mainFrameListeners = new Set<FrameListener>();
  private bcFrameListeners = new Set<BcFrameListener>();
  private bcReassembler = new Protocol.BcFrameReassembler();
  private mainSub?: Subscription;
  private bcSub?: Subscription;
  private bcReady = false;

  private constructor(device: Device) {
    this.device = device;
  }

  get deviceId(): string {
    return this.device.id;
  }

  get name(): string | null {
    return this.device.name;
  }

  static async connect(deviceId: string): Promise<H59Connection> {
    const device = await bleManager.connectToDevice(deviceId, { timeout: 15000 });
    await device.discoverAllServicesAndCharacteristics();
    const conn = new H59Connection(device);

    conn.mainSub = device.monitorCharacteristicForService(
      Protocol.SERVICE_UART,
      Protocol.CHARACTERISTIC_NOTIFY,
      (error, characteristic) => {
        if (error || !characteristic?.value) return;
        const bytes = base64ToBytes(characteristic.value);
        for (const listener of conn.mainFrameListeners) listener(bytes);
      },
    );

    try {
      conn.bcSub = device.monitorCharacteristicForService(
        Protocol.SERVICE_BIGDATA,
        Protocol.CHARACTERISTIC_BIGDATA_NOTIFY,
        (error, characteristic) => {
          if (error || !characteristic?.value) return;
          const bytes = base64ToBytes(characteristic.value);
          const frames = conn.bcReassembler.push(bytes);
          for (const frame of frames) for (const listener of conn.bcFrameListeners) listener(frame);
        },
      );
      conn.bcReady = true;
    } catch {
      conn.bcReady = false; // firmware without the rich channel — SpO2/sleep history unavailable
    }

    return conn;
  }

  async disconnect(): Promise<void> {
    this.mainSub?.remove();
    this.bcSub?.remove();
    await bleManager.cancelDeviceConnection(this.device.id).catch(() => undefined);
  }

  /** Fires if the connection drops unexpectedly (out of range, band powered off, etc). */
  onDisconnected(callback: (error: Error | null) => void): Subscription {
    return bleManager.onDeviceDisconnected(this.device.id, (error) => callback(error));
  }

  private async writeMain(frame: Uint8Array): Promise<void> {
    await this.device.writeCharacteristicWithoutResponseForService(
      Protocol.SERVICE_UART,
      Protocol.CHARACTERISTIC_WRITE,
      bytesToBase64(frame),
    );
  }

  private async writeBc(frame: Uint8Array): Promise<void> {
    await this.device.writeCharacteristicWithoutResponseForService(
      Protocol.SERVICE_BIGDATA,
      Protocol.CHARACTERISTIC_BIGDATA_WRITE,
      bytesToBase64(frame),
    );
  }

  /** Sends a main-channel frame and collects every response with a matching cmd byte until the device goes quiet. */
  private requestMain(
    cmd: number,
    frame: Uint8Array,
    { timeoutMs = 6000, quietMs = 400 }: { timeoutMs?: number; quietMs?: number } = {},
  ): Promise<Protocol.ParsedFrame[]> {
    return new Promise((resolve, reject) => {
      const collected: Protocol.ParsedFrame[] = [];
      let quietTimer: ReturnType<typeof setTimeout> | null = null;

      const cleanup = () => {
        clearTimeout(hardTimer);
        if (quietTimer) clearTimeout(quietTimer);
        this.mainFrameListeners.delete(listener);
      };
      const listener: FrameListener = (bytes) => {
        if (bytes.length !== Protocol.FRAME_LENGTH || bytes[0] !== cmd) return;
        collected.push(Protocol.parseFrame(bytes));
        if (quietTimer) clearTimeout(quietTimer);
        quietTimer = setTimeout(() => {
          cleanup();
          resolve(collected);
        }, quietMs);
      };
      const hardTimer = setTimeout(() => {
        cleanup();
        resolve(collected);
      }, timeoutMs);

      this.mainFrameListeners.add(listener);
      this.writeMain(frame).catch((err) => {
        cleanup();
        reject(err);
      });
    });
  }

  /** Sends a bc-channel request and returns the longest response body of the matching type. */
  private requestBc(type: number, frame: Uint8Array, timeoutMs = 6000): Promise<Uint8Array | null> {
    return new Promise((resolve, reject) => {
      let best: Uint8Array | null = null;
      const cleanup = () => {
        clearTimeout(timer);
        this.bcFrameListeners.delete(listener);
      };
      const listener: BcFrameListener = (f) => {
        if (f.type !== type) return;
        if (!best || f.body.length > best.length) best = f.body;
        if (f.body.length > 3) {
          cleanup();
          resolve(best);
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve(best);
      }, timeoutMs);

      this.bcFrameListeners.add(listener);
      this.writeBc(frame).catch((err) => {
        cleanup();
        reject(err);
      });
    });
  }

  // ---------------------------------------------------------------------
  // High-level, SUPPORTED protocol operations — see docs/BLE_PROTOCOL.md
  // ---------------------------------------------------------------------

  async readCapabilities(): Promise<DeviceCapabilities> {
    const frames = await this.requestMain(Protocol.CMD.SET_TIME, Protocol.setTime(new Date()));
    if (!frames[0]) throw new Error("No response to set_time — could not read device capabilities");
    return Protocol.decodeCapabilities(frames[0]);
  }

  async readBattery(): Promise<{ level: number; charging: boolean }> {
    const frames = await this.requestMain(Protocol.CMD.BATTERY, Protocol.requestBattery());
    if (!frames[0]) throw new Error("No response to battery request");
    return Protocol.parseBattery(frames[0]);
  }

  async readHeartRateHistory(dayMidnightLocalAsUtcSeconds: number) {
    const frames = await this.requestMain(
      Protocol.CMD.HR_HISTORY,
      Protocol.requestHeartRateHistory(dayMidnightLocalAsUtcSeconds),
      { timeoutMs: 8000 },
    );
    return Protocol.parseHeartRateHistory(frames);
  }

  async readStepsHistory(day: number) {
    const frames = await this.requestMain(Protocol.CMD.STEPS, Protocol.requestStepsHistory(day));
    return Protocol.parseStepsHistory(frames);
  }

  async readStressHistory(day: number) {
    const frames = await this.requestMain(Protocol.CMD.STRESS_HISTORY, Protocol.requestStressHistory(day));
    return Protocol.parseSlotHistory(frames);
  }

  async readHrvHistory(day: number) {
    const frames = await this.requestMain(Protocol.CMD.HRV_HISTORY, Protocol.requestHrvHistory(day));
    return Protocol.parseSlotHistory(frames);
  }

  get supportsRichChannel(): boolean {
    return this.bcReady;
  }

  async bcLogin(account: string): Promise<void> {
    await this.writeBc(Protocol.bcLogin(account));
    await sleep(400);
    await this.writeBc(Protocol.bcInit());
    await sleep(400);
  }

  async readSpo2History(day: number) {
    if (!this.bcReady) return [];
    const body = await this.requestBc(Protocol.BC_TYPE.SPO2, Protocol.requestSpo2History(day));
    return body ? Protocol.parseSpo2History(body) : [];
  }

  /** Every stored night in one call — see docs/BLE_PROTOCOL.md ("device ignores the day parameter"). */
  async readSleepNights() {
    if (!this.bcReady) return [];
    const body = await this.requestBc(Protocol.BC_TYPE.SLEEP, Protocol.requestSleepNights());
    return body ? Protocol.parseSleepBlob(body) : [];
  }

  /** Repeatedly samples a real-time metric and returns the median of the readings that locked on (optical sensors are noisy). */
  async measureRealtime(
    type: (typeof Protocol.REALTIME_TYPE)[keyof typeof Protocol.REALTIME_TYPE],
    { timeoutMs = 25000, wantReadings = 5 }: { timeoutMs?: number; wantReadings?: number } = {},
  ): Promise<Protocol.RealtimeReading | null> {
    const readings: Protocol.RealtimeReading[] = [];

    const result = await new Promise<Protocol.RealtimeReading | null>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(hardTimer);
        this.mainFrameListeners.delete(listener);
      };
      const listener: FrameListener = (bytes) => {
        if (bytes.length !== Protocol.FRAME_LENGTH || bytes[0] !== Protocol.CMD.REALTIME) return;
        const frame = Protocol.parseFrame(bytes);
        const reading = Protocol.parseRealtimeFrame(frame);
        if (reading.ok) readings.push(reading);
        if (readings.length >= wantReadings) {
          cleanup();
          resolve(medianReading(readings, type));
        }
      };
      const hardTimer = setTimeout(() => {
        cleanup();
        resolve(readings.length ? medianReading(readings, type) : null);
      }, timeoutMs);

      this.mainFrameListeners.add(listener);
      this.writeMain(Protocol.startRealtimeMeasurement(type)).catch((err) => {
        cleanup();
        reject(err);
      });
    });

    await this.writeMain(Protocol.stopRealtimeMeasurement(type)).catch(() => undefined);
    return result;
  }

  /** EXPERIMENTAL — see docs/BLE_PROTOCOL.md. Not confirmed to vibrate on a real H59 yet. */
  async experimentalVibrate(): Promise<void> {
    await this.writeMain(Protocol.experimentalFindDeviceOrVibrate());
  }
}

function medianReading(
  readings: Protocol.RealtimeReading[],
  type: (typeof Protocol.REALTIME_TYPE)[keyof typeof Protocol.REALTIME_TYPE],
): Protocol.RealtimeReading | null {
  if (!readings.length) return null;
  if (type === Protocol.REALTIME_TYPE.BLOOD_PRESSURE) {
    const systolics = readings.map((r) => r.bloodPressure?.systolic).filter((v): v is number => v != null).sort((a, b) => a - b);
    const diastolics = readings.map((r) => r.bloodPressure?.diastolic).filter((v): v is number => v != null).sort((a, b) => a - b);
    if (!systolics.length || !diastolics.length) return null;
    return {
      ...readings[readings.length - 1]!,
      bloodPressure: { systolic: median(systolics), diastolic: median(diastolics) },
    };
  }
  const key = type === Protocol.REALTIME_TYPE.HEART_RATE ? "heartRate" : type === Protocol.REALTIME_TYPE.SPO2 ? "spo2" : "stress";
  const values = readings.map((r) => r[key as "heartRate" | "spo2" | "stress"]).filter((v): v is number => v != null).sort((a, b) => a - b);
  if (!values.length) return null;
  return { ...readings[readings.length - 1]!, [key]: median(values) };
}

function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : Math.round(((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2);
}
