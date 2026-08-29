(function (root, factory) {
    'use strict';
    root.BrainLumeBle = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const UUID = Object.freeze({
        service: '0000abf0-0000-1000-8000-00805f9b34fb',
        write: '0000abf1-0000-1000-8000-00805f9b34fb',
        notify: '0000abf2-0000-1000-8000-00805f9b34fb',
    });
    const DEVICE_NAME = 'BrainLume2.0C';

    class BleTransport {
        constructor(options = {}) {
            this.uuids = { ...UUID, ...(options.uuids || {}) };
            this.reuseGrantedDevice = Boolean(options.reuseGrantedDevice);
            this.requireGrantedDevice = Boolean(options.requireGrantedDevice);
            this.connectAttempts = Math.max(1, Number(options.connectAttempts) || 3);
            this.connectRetryDelayMs = Math.max(250, Number(options.connectRetryDelayMs) || 1000);
            this.availableDevices = [];
            this.device = null;
            this.server = null;
            this.writeCharacteristic = null;
            this.notifyCharacteristic = null;
            this.listeners = new Set();
            this.disconnectListeners = new Set();
            this.statusListeners = new Set();
            this.writeQueue = Promise.resolve();
            this.name = '';
            this.id = '';
            this._onNotification = event => {
                const view = event.target.value;
                const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength).slice();
                for (const listener of this.listeners) listener(bytes);
            };
            this._onDisconnected = () => {
                this.server = null;
                this.writeCharacteristic = null;
                this.notifyCharacteristic = null;
                for (const listener of this.disconnectListeners) listener();
            };
        }

        _emitStatus(detail) {
            for (const listener of this.statusListeners) listener(detail);
        }

        _clearGattState(disconnect = false) {
            if (this.notifyCharacteristic) {
                this.notifyCharacteristic.removeEventListener('characteristicvaluechanged', this._onNotification);
            }
            if (disconnect && this.device?.gatt?.connected) {
                try { this.device.gatt.disconnect(); } catch { /* selected device may already be disconnected */ }
            }
            this.server = null;
            this.writeCharacteristic = null;
            this.notifyCharacteristic = null;
        }

        async _connectGattOnce(attempt) {
            let stage = 'gatt_connect';
            try {
                this.server = await this.device.gatt.connect();
                stage = 'service_discovery';
                const service = await this.server.getPrimaryService(this.uuids.service);
                stage = 'write_characteristic';
                this.writeCharacteristic = await service.getCharacteristic(this.uuids.write);
                stage = 'notify_characteristic';
                this.notifyCharacteristic = await service.getCharacteristic(this.uuids.notify);
                stage = 'notification_subscription';
                this.notifyCharacteristic.addEventListener('characteristicvaluechanged', this._onNotification);
                await this.notifyCharacteristic.startNotifications();
                this.device.removeEventListener('gattserverdisconnected', this._onDisconnected);
                this.device.addEventListener('gattserverdisconnected', this._onDisconnected);
                this._emitStatus({ phase: 'connected', stage, attempt, maxAttempts: this.connectAttempts });
                return;
            } catch (error) {
                this._clearGattState(true);
                this._emitStatus({
                    phase: 'attempt_failed', stage, attempt, maxAttempts: this.connectAttempts,
                    error: error?.message || String(error),
                });
                error.bleStage = stage;
                error.bleAttempt = attempt;
                throw error;
            }
        }

        async connect() {
            if (!navigator.bluetooth) throw new Error('当前 Electron/系统不支持 Web Bluetooth');
            if (this.isConnected()) return this;
            if (this.reuseGrantedDevice && typeof navigator.bluetooth.getDevices === 'function') {
                const granted = await navigator.bluetooth.getDevices();
                this.availableDevices = granted.map(device => ({ name: device.name || '', id: device.id || '' }));
                this.availableDevices = this.availableDevices.filter(device => device.name === DEVICE_NAME);
                this.device = granted.find(device => device.name === DEVICE_NAME) || null;
            }
            if (!this.device && this.requireGrantedDevice) {
                throw Object.assign(new Error('No authorized BrainLume2.0C device available'), {
                    code: 'NO_AUTHORIZED_DEVICE',
                });
            }
            if (!this.device) {
                this.device = await navigator.bluetooth.requestDevice({
                    filters: [{ name: DEVICE_NAME }, { services: [this.uuids.service] }],
                    optionalServices: [this.uuids.service],
                });
            }
            this.name = this.device.name || '未命名 BLE 设备';
            this.id = this.device.id;
            let lastError = null;
            for (let attempt = 1; attempt <= this.connectAttempts; attempt += 1) {
                this._emitStatus({ phase: 'attempt_started', stage: 'gatt_connect', attempt, maxAttempts: this.connectAttempts });
                try {
                    await this._connectGattOnce(attempt);
                    return this;
                } catch (error) {
                    lastError = error;
                    if (attempt < this.connectAttempts) {
                        await new Promise(resolve => setTimeout(resolve, this.connectRetryDelayMs * attempt));
                    }
                }
            }
            const stage = lastError?.bleStage || 'gatt_connect';
            const message = lastError?.message || String(lastError || 'Unknown BLE error');
            throw Object.assign(new Error(`BrainLume BLE 连接失败（阶段 ${stage}，已尝试 ${this.connectAttempts} 次）：${message}`), {
                code: 'BLE_CONNECT_RETRIES_EXHAUSTED',
                bleStage: stage,
                attempts: this.connectAttempts,
                cause: lastError,
            });
        }

        async disconnect() {
            if (this.notifyCharacteristic) {
                try { await this.notifyCharacteristic.stopNotifications(); } catch { /* device may already be gone */ }
                this.notifyCharacteristic.removeEventListener('characteristicvaluechanged', this._onNotification);
            }
            if (this.device?.gatt?.connected) this.device.gatt.disconnect();
            this.server = null;
            this.writeCharacteristic = null;
            this.notifyCharacteristic = null;
        }

        isConnected() {
            return Boolean(this.device?.gatt?.connected && this.writeCharacteristic && this.notifyCharacteristic);
        }

        onData(callback) {
            this.listeners.add(callback);
            return () => this.listeners.delete(callback);
        }

        onDisconnect(callback) {
            this.disconnectListeners.add(callback);
            return () => this.disconnectListeners.delete(callback);
        }

        onStatus(callback) {
            this.statusListeners.add(callback);
            return () => this.statusListeners.delete(callback);
        }

        write(bytes) {
            const payload = Uint8Array.from(bytes || []);
            const execute = async () => {
                if (!this.isConnected()) throw new Error('BLE 未连接');
                for (let offset = 0; offset < payload.length; offset += 20) {
                    const chunk = payload.slice(offset, offset + 20);
                    if (typeof this.writeCharacteristic.writeValueWithoutResponse === 'function') {
                        await this.writeCharacteristic.writeValueWithoutResponse(chunk);
                    } else {
                        await this.writeCharacteristic.writeValue(chunk);
                    }
                }
            };
            const result = this.writeQueue.then(execute, execute);
            this.writeQueue = result.catch(() => {});
            return result;
        }
    }

    return Object.freeze({ UUID, DEVICE_NAME, BleTransport });
}));
