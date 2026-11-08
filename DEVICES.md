# Device Integration Documentation

## Overview

This document describes all monitored Tuya devices, their API endpoints, data mappings, and verified specifications.

## Device List

### Power Monitoring Sockets

#### Socket 1 (Розетка 1) - Heater Input
- **Device ID**: `bf3c70a960958bcf11ruml`
- **Storage ID**: `obogrevatel` (since 2025-01-27 19:24 Kyiv)
- **API Endpoint**: `/v1.0/devices/{id}/status`
- **Grid Witness**: Yes (input socket)
- **SvitloBot Witness**: Yes
- **Controllable**: Yes (as "Обогреватель")

#### Socket 2 (Розетка 2) - Kitchen Socket
- **Device ID**: `bfcbd371e1af7827f9sj79`
- **API Endpoint**: `/v1.0/devices/{id}/status`
- **Grid Witness**: Yes (primary)
- **SvitloBot Witness**: Yes
- **Controllable**: Yes
- **Data Points**:
  - `switch_1`: Boolean (on/off state)
  - `cur_voltage`: Integer, scale=1 (divide by 10 to get Volts)
  - `cur_power`: Integer, scale=1 (divide by 10 to get Watts)
  - `cur_current`: Integer, scale=0 (raw mA value)

#### Socket 3 (Розетка 3) - NEW
- **Device ID**: `bfc46baade5494be88qqgb`
- **Product**: Smart Plug (product_id: hlfmbtcfrcqvnqja)
- **API Endpoint**: `/v1.0/devices/{id}/status`
- **Grid Witness**: **NO** (excluded from grid power detection)
- **SvitloBot Witness**: **NO** (excluded from outage detection)
- **Controllable**: No
- **Specifications Source**: ✅ **VERIFIED** via `/v1.0/devices/{id}/specifications` (2026-11-08 19:45 Kyiv)
- **Data Points**:
  - `switch_1`: Boolean (on/off state)
  - `cur_voltage`: Integer, unit=V, **scale=1** → divide by 10 to get Volts ✅ VERIFIED
  - `cur_power`: Integer, unit=W, **scale=1** → divide by 10 to get Watts ✅ VERIFIED
  - `cur_current`: Integer, unit=mA, scale=0 → raw mA value
  - `add_ele`: Integer, unit=kW·h, scale=3 → divide by 1000
  - `countdown_1`: Integer, unit=seconds, scale=0
  - `fault`: Integer
- **Special Handling**: Preserves true zero power (0W is stored as 0, not null)
- **Real Data Example** (2026-11-08 19:44 Kyiv):
  ```json
  {
    "online": true,
    "switch_1": false,
    "cur_voltage": 2306,  // → 230.6V
    "cur_power": 0,       // → 0W (true zero)
    "cur_current": 0      // → 0mA
  }
  ```

### Temperature & Humidity Sensors

#### T & H Sensor (Existing)
- **Device ID**: `bf2bf2252c37a041b0tbvs`
- **API Endpoint**: `/v2.0/cloud/thing/{id}/shadow/properties`
- **Data Points**:
  - `temp_current`: Integer (dp_id 102), scale assumed /10 for °C
  - `humidity_value`: Integer (dp_id 103), unchanged (%)

#### T & H Sensor 2 - NEW
- **Device ID**: `bf829227fc480fdeabiwof`
- **Product**: T & H Sensor (product_id: xeagimantb7d7apb)
- **API Endpoint**: `/v2.0/cloud/thing/{id}/shadow/properties`
  - ⚠️ **Note**: `/v1.0/devices/{id}/status` returns code 2003 "function not support"
  - ⚠️ **Note**: `/v1.0/iot-03/devices/{id}/status` returns success with empty array
  - Must use shadow API without `codes` query parameter (returns empty if filtered)
- **Specifications Source**: ⚠️ **NOT VERIFIED** - `/v1.0/devices/{id}/specifications` returns code 2009 "not support this device"
- **Data Points**:
  - `temp_current`: Integer (dp_id 102) → ⚠️ **INFERRED** scale /10 for °C (same as existing sensor)
  - `humidity_value`: Integer (dp_id 103) → ⚠️ **INFERRED** unchanged (%) (same as existing sensor)
  - `battery_state`: Enum (dp_id 104) → values like "high", "middle", "low" (NOT a percentage)
- **Scale Mapping Inference**: Since Tuya specs API doesn't support this device, we apply the same scale logic as the existing sensor `bf2bf2252c37a041b0tbvs` (v2.0 shadow API, temp_current /10, humidity unchanged)
- **Real Data Example** (2026-11-08 19:44 Kyiv):
  ```json
  {
    "online": true,
    "properties": [
      { "code": "temp_current", "dp_id": 102, "value": 207 },    // → 20.7°C (INFERRED)
      { "code": "humidity_value", "dp_id": 103, "value": 45 },   // → 45% (INFERRED)
      { "code": "battery_state", "dp_id": 104, "value": "high" }
    ]
  }
  ```

### Control Relays (Lights)

#### Kitchen Light (Свет на кухне)
- **Device ID**: `bf2a33ded6cd1955cbumtz`
- **SvitloBot Witness**: Yes (proves internet connectivity)
- **Controllable**: Yes

#### Corridor Light / Boiler (Бойлер)
- **Device ID**: `bf935c8cff3752fbecgfew`
- **Environment Variable**: `BOILER_DEVICE_ID`
- **SvitloBot Witness**: Yes (proves internet connectivity)
- **Controllable**: Yes
- **Added**: PR #19 (commit 0941d8da1a6ca5ad1bcb03417ebac7851fee6ca5)

#### Plant Light (Подсветка цветам)
- **Device ID**: `bffd4e253c18de762ct932`
- **Controllable**: Yes

## API Endpoint Patterns

### Standard Status Endpoint
Used by: Socket 1, Socket 2, Socket 3, Lights

```
GET /v1.0/devices/{device_id}/status
```

Returns array of `{ code, value }` objects.

Fallback if code 2003 "function not support":
```
GET /v1.0/iot-03/devices/{device_id}/status
```

### Shadow Properties Endpoint
Used by: T & H Sensor, T & H Sensor 2

```
GET /v2.0/cloud/thing/{device_id}/shadow/properties
```

⚠️ **Important**: Do NOT use `?codes=` query parameter - it returns empty results. Request all properties and filter by `code` in application logic.

Returns object with `properties` array:
```json
{
  "properties": [
    { "code": "...", "dp_id": ..., "value": ... }
  ]
}
```

### Device Specifications Endpoint
```
GET /v1.0/devices/{device_id}/specifications
```

Returns unit and scale information for device data points.
- **scale=0**: Raw value (no conversion)
- **scale=1**: Divide by 10
- **scale=2**: Divide by 100
- **scale=3**: Divide by 1000

⚠️ Not all devices support this endpoint (e.g., T & H Sensor 2 returns code 2009).

## Grid Power & SvitloBot Logic

### Grid Presence Detection
**Devices Used**: SOCKET2 (`bfcbd371e1af7827f9sj79`) ONLY

Logic in `gridPower.js`:
- `isOnline=true` AND `voltageV >= 50V` → Grid present
- `isOnline=true` AND `voltageV < 50V` → Grid absent
- `isOnline=false` → Grid absent
- `voltageV=null` → Unknown

⚠️ **Socket 3 is NOT used for grid detection** - it's monitored independently.

### SvitloBot Outage Detection
**Socket Witnesses**: Socket 1 (Heater), Socket 2 ONLY  
**Internet Witnesses**: Kitchen Light, Corridor Light

Logic in `svitlobot.js`:
- At least ONE socket online → "on" (light present)
- BOTH sockets offline + at least ONE witness online → "off" (confirmed outage)
- BOTH sockets offline + NO witness online → "unknown" (possible router reboot)

⚠️ **Socket 3 is NOT used for SvitloBot logic** - existing dual-socket witness semantics preserved.

## Device Online vs Telemetry Freshness

**Important Distinction**:
- `online=true` means the device has an active cloud connection
- Telemetry timestamps indicate when data was last updated
- A device can be `online=true` with stale telemetry (e.g., 6+ minutes old)
- Do NOT confuse online status with data freshness

Example from 2026-11-08 19:44 Kyiv check:
- Socket 3: `online=true`, last telemetry 19:01 (43 min stale)
- Sensor 2: `online=true`, last telemetry 19:38 (6 min stale)

## Database Schema

Table: `power_status`

Relevant columns for new devices:
- `device_id`: VARCHAR(50) - Device ID or alias (e.g., "obogrevatel", "bfc46baade5494be88qqgb")
- `device_name`: VARCHAR(100) - Display name (e.g., "Розетка 3", "T & H Sensor 2")
- `is_online`: TINYINT(1) - Device online status
- `switch_on`: TINYINT(1) - Switch state (sockets/lights only)
- `power_consumption_w`: DECIMAL(10,2) - Power in Watts (preserves true zero)
- `voltage_v`: DECIMAL(5,2) - Voltage in Volts
- `temperature_c`: DECIMAL(5,2) - Temperature in Celsius (sensors only)
- `humidity_percent`: DECIMAL(5,2) - Humidity percentage (sensors only)

All existing columns remain unchanged for backward compatibility.

## Testing

### Unit Tests
- `newDevices.test.js`: Device registration, specifications, exclusion from grid/SvitloBot
- `test/newDevicesIntegration.test.js`: API parsing, database mapping, backward compatibility

### Test Coverage
- ✅ Socket 3 verified scale mappings (voltage, power)
- ⚠️ Sensor 2 inferred scale mappings (documented as unverified)
- ✅ Grid power logic excludes Socket 3
- ✅ SvitloBot logic excludes Socket 3
- ✅ Backward compatibility with existing API responses
- ✅ Database field mapping for both new devices
- ✅ Sort order in device lists

Run tests:
```bash
node newDevices.test.js
node test/newDevicesIntegration.test.js
node svitlobot.test.js  # Verify no regressions
```

## Migration Notes

### No Database Migration Required
New devices use existing schema columns. No ALTER TABLE statements needed.

### Environment Variables
Devices are added to default `DEVICE_IDS` object. Override with:
```bash
DEVICE_IDS='{"Розетка 3": "bfc46baade5494be88qqgb", "T & H Sensor 2": "bf829227fc480fdeabiwof", ...}'
```

### Frontend Updates
If frontend is maintained separately (e.g., `C:\PRJ_my\roz`), device registration may need manual updates. API responses remain backward compatible.

## Known Limitations

1. **Sensor 2 Scale Unverified**: Temperature and humidity scales are inferred from existing sensor behavior, not confirmed by Tuya specifications API (returns code 2009).

2. **Battery State**: Sensor 2's `battery_state` is an enum ("high", "middle", "low"), not a numeric percentage. Currently not stored to database.

3. **Telemetry Staleness**: Online devices may report stale data. Consider timestamp validation for time-sensitive applications.

4. **Socket 3 Control**: Currently not added to controllable devices list. Can be added if needed (requires adding to `CONTROLLABLE_DEVICE_IDS` and `CONTROL_ID_MAP` in `index.js`).

## Evidence & Verification Log

All mappings based on actual API responses retrieved 2026-11-08 19:44-19:45 Europe/Kiev:

### Socket 3
- ✅ `/v1.0/devices/bfc46baade5494be88qqgb/status` - success
- ✅ `/v1.0/devices/bfc46baade5494be88qqgb/specifications` - success, scale values verified
- Product: Smart Plug (hlfmbtcfrcqvnqja), category: tdq

### Sensor 2  
- ❌ `/v1.0/devices/bf829227fc480fdeabiwof/status` - code 2003 "function not support"
- ✅ `/v1.0/iot-03/devices/bf829227fc480fdeabiwof/status` - success but empty array
- ✅ `/v2.0/cloud/thing/bf829227fc480fdeabiwof/shadow/properties` - success
- ❌ `/v1.0/devices/bf829227fc480fdeabiwof/specifications` - code 2009 "not support this device"
- Product: T & H Sensor (xeagimantb7d7apb), category: tdq
