# Implementation Summary: Socket 3 and T&H Sensor 2 Integration

**PR**: [#20](https://github.com/yatsenkoleg-spiralsoft/power-monitor/pull/20)  
**Branch**: `cursor/add-socket3-and-th-sensor2-324d`  
**Date**: 2026-11-08  
**Status**: Ready for Review (No Merge/Deploy)

## Executive Summary

Successfully integrated two new Tuya devices into the power monitoring system with minimal, surgical changes that preserve all existing logic. Socket 3 uses verified API specifications, while T&H Sensor 2 uses inferred scale mappings documented as unverified.

## Devices Added

### Socket 3 (Розетка 3)
- **ID**: `bfc46baade5494be88qqgb`
- **Endpoint**: `/v1.0/devices/{id}/status`
- **Specifications**: ✅ **VERIFIED** via Tuya API (2026-11-08 19:45 Kyiv)
  - Voltage: scale=1 (÷10) → V
  - Power: scale=1 (÷10) → W
  - Preserves true zero (0W ≠ null)
- **NOT** added to grid power or SvitloBot logic

### T & H Sensor 2
- **ID**: `bf829227fc480fdeabiwof`
- **Endpoint**: `/v2.0/cloud/thing/{id}/shadow/properties`
- **Specifications**: ⚠️ **INFERRED** (Tuya specs API unsupported, code 2009)
  - Temperature: /10 scale → °C (inferred from existing sensor)
  - Humidity: unchanged → % (inferred from existing sensor)
  - Battery: enum ("high"/"middle"/"low"), not percentage

## Changes Made

### Code Changes

#### `tuya.js`
```javascript
// Added to DEVICE_IDS default:
'Розетка 3': 'bfc46baade5494be88qqgb',
'T & H Sensor 2': 'bf829227fc480fdeabiwof',

// Extended shadow API check:
const TH_SENSOR2_DEVICE_ID = 'bf829227fc480fdeabiwof';
if (deviceId === TH_SENSOR_DEVICE_ID || deviceId === TH_SENSOR2_DEVICE_ID) {
    // Use /v2.0/cloud/thing/{id}/shadow/properties
}
```

#### `index.js`
```javascript
// Added constants:
const TH_SENSOR2_DEVICE_ID = 'bf829227fc480fdeabiwof';
const SOCKET3_DEVICE_ID = 'bfc46baade5494be88qqgb';

// Updated sort order:
const DEVICE_SORT_ORDER = [
    SOCKET2_DEVICE_ID,
    SOCKET3_DEVICE_ID,      // NEW
    HEATER_DEVICE_ID,
    'ecoflow',
    'marstek',
    KITCHEN_LIGHT_DEVICE_ID,
    BOILER_DEVICE_ID,
    PLANT_LIGHT_DEVICE_ID,
    TH_SENSOR_DEVICE_ID,
    TH_SENSOR2_DEVICE_ID,   // NEW
];
```

### Documentation Added

- **DEVICES.md**: Comprehensive device documentation
  - All device specifications
  - API endpoint patterns
  - Verified vs inferred mappings
  - Grid power and SvitloBot logic
  - Known limitations
  - Evidence log

### Tests Added

- **newDevices.test.js**: 16 unit tests
  - Device registration
  - Scale mappings (verified vs inferred)
  - Exclusion from grid/SvitloBot
  - Real API fixtures
  - Backward compatibility

- **test/newDevicesIntegration.test.js**: 11 integration tests
  - API parsing with real data
  - Database field mapping
  - Grid power exclusion verification
  - SvitloBot exclusion verification
  - Sort order
  - Response compatibility

## Critical Scope Constraints (All Met)

### ✅ Implemented
- [x] Socket 3 and Sensor 2 added to polling
- [x] Data stored to existing schema (no migrations)
- [x] API endpoints serve new devices
- [x] Comprehensive tests (27 new, all pass)
- [x] Verified vs inferred mappings documented
- [x] Backward compatibility maintained

### ❌ Explicitly Excluded (Per Requirements)
- [x] NO changes to gridPower logic (SOCKET2 remains sole witness)
- [x] NO changes to SvitloBot sockets/witnesses (Socket1/Socket2 only)
- [x] NO changes to witness semantics (Kitchen OR Corridor)
- [x] NO Socket 3 added to controllable devices
- [x] NO live /monitor endpoints or Ping/PingOff changes
- [x] NO device control implementations
- [x] NO deployments or merges
- [x] NO production DB/env changes

## Testing Results

### All Tests Passing ✅

```bash
# New device unit tests
$ node newDevices.test.js
TAP version 13
# tests 16
# pass 16
# fail 0

# New device integration tests  
$ node test/newDevicesIntegration.test.js
TAP version 13
# tests 11
# pass 11
# fail 0

# Existing tests (no regressions)
$ node svitlobot.test.js
TAP version 13
# tests 15
# pass 15
# fail 0
```

**Total**: 42 tests, 42 passing, 0 failures

## API Evidence (2026-11-08 19:44-19:45 Kyiv)

### Socket 3 Verified
```bash
# Device info
GET /v1.0/devices/bfc46baade5494be88qqgb
→ online: true, product: Smart Plug

# Status (works)
GET /v1.0/devices/bfc46baade5494be88qqgb/status
→ success: true
→ switch_1: false
→ cur_voltage: 2306 (230.6V)
→ cur_power: 0 (0W)
→ cur_current: 0 (0mA)

# Specifications (VERIFIED)
GET /v1.0/devices/bfc46baade5494be88qqgb/specifications
→ success: true
→ cur_voltage: unit=V, scale=1 (÷10) ✅
→ cur_power: unit=W, scale=1 (÷10) ✅
→ cur_current: unit=mA, scale=0 ✅
```

### Sensor 2 Inferred
```bash
# Device info
GET /v1.0/devices/bf829227fc480fdeabiwof
→ online: true, product: T & H Sensor

# Status (NOT SUPPORTED)
GET /v1.0/devices/bf829227fc480fdeabiwof/status
→ code: 2003 "function not support" ❌

# IoT-03 status (EMPTY)
GET /v1.0/iot-03/devices/bf829227fc480fdeabiwof/status
→ success: true, result: [] ❌

# Shadow properties (WORKS)
GET /v2.0/cloud/thing/bf829227fc480fdeabiwof/shadow/properties
→ success: true ✅
→ temp_current: 207 (dp_id 102) → 20.7°C inferred
→ humidity_value: 45 (dp_id 103) → 45% inferred
→ battery_state: "high" (dp_id 104)

# Specifications (NOT SUPPORTED)
GET /v1.0/devices/bf829227fc480fdeabiwof/specifications
→ success: false
→ code: 2009 "not support this device" ❌
```

## Key Implementation Details

### Socket 3 Power Handling
```javascript
// Preserve true zero power (not null)
const powerValue = statusMap['cur_power'];
const powerW = powerValue !== null && powerValue !== undefined 
    ? Number(powerValue) / 10 
    : null;

// Example: cur_power=0 → powerW=0 (not null)
// This is critical for accurate history/statistics
```

### Sensor 2 Shadow API
```javascript
// Must request ALL properties (codes filter returns empty)
const pathShadow = `/v2.0/cloud/thing/${deviceId}/shadow/properties`;
// NO ?codes=1,2 query parameter

// Filter by code after receiving:
result.properties.forEach(p => {
    if (p.code != null && p.value !== undefined) {
        statusMap[String(p.code)] = p.value;
    }
});
```

### Grid Power Exclusion
```javascript
// gridPower.js - UNCHANGED
const SOCKET2_DEVICE_ID = 'bfcbd371e1af7827f9sj79'; // Only SOCKET2

function computeGridPresent(isOnline, voltageV) {
    // Socket 3 is NEVER passed here
    if (!isOnline) return false;
    if (voltageV === null || voltageV === undefined || Number.isNaN(Number(voltageV))) {
        return null;
    }
    return Number(voltageV) >= GRID_VOLTAGE_THRESHOLD;
}
```

### SvitloBot Exclusion
```javascript
// svitlobot.js - UNCHANGED
function aggregateReadings(
    inputSocketResult,    // Socket1/Heater only
    kitchenSocketResult,  // Socket2 only
    kitchenLightResult,   // Kitchen witness
    corridorLightResult   // Corridor witness
) {
    // Socket 3 is NEVER passed as a parameter
}
```

## Verification vs Inference Matrix

| Device | Field | Scale | Source | Status |
|--------|-------|-------|--------|--------|
| Socket 3 | cur_voltage | ÷10 → V | Tuya specs API | ✅ VERIFIED |
| Socket 3 | cur_power | ÷10 → W | Tuya specs API | ✅ VERIFIED |
| Socket 3 | cur_current | raw → mA | Tuya specs API | ✅ VERIFIED |
| Sensor 2 | temp_current | ÷10 → °C | Existing sensor logic | ⚠️ INFERRED |
| Sensor 2 | humidity_value | ×1 → % | Existing sensor logic | ⚠️ INFERRED |
| Sensor 2 | battery_state | enum | Shadow API | ✅ CONFIRMED |

## Database Integration

### No Migration Required
Existing schema supports all fields:
```sql
-- power_status table (existing columns used)
device_id VARCHAR(50)           -- 'bfc46baade5494be88qqgb', 'bf829227fc480fdeabiwof'
device_name VARCHAR(100)        -- 'Розетка 3', 'T & H Sensor 2'
is_online TINYINT(1)           -- Online status
switch_on TINYINT(1)           -- Socket 3 only
power_consumption_w DECIMAL(10,2)  -- Socket 3 (preserves 0)
voltage_v DECIMAL(5,2)         -- Socket 3
temperature_c DECIMAL(5,2)     -- Sensor 2 (inferred)
humidity_percent DECIMAL(5,2)  -- Sensor 2 (inferred)
```

### Data Flow
```
Tuya API → checkDeviceAvailability() → savePowerStatus() → MySQL
   ↓
API Responses:
  GET /api/current    (last DB snapshot)
  GET /api/monitor    (live check, no DB write)
  GET /api/stats      (historical data)
  GET /api/daily      (aggregated by day)
```

## Backward Compatibility

### API Responses ✅ Unchanged
- `/api/current`: New devices added to array, same structure
- `/api/monitor`: New devices in results, same fields
- `/api/stats`: Works with new device_ids
- `/api/daily`: Works with new device_ids
- `/api/widget`: Unchanged (uses SOCKET2 and ecoflow only)

### Existing Devices ✅ Unaffected
All 6 existing devices remain functional:
- Socket 1 / Heater (bf3c70a960958bcf11ruml / obogrevatel)
- Socket 2 (bfcbd371e1af7827f9sj79)
- T&H Sensor (bf2bf2252c37a041b0tbvs)
- Kitchen Light (bf2a33ded6cd1955cbumtz)
- Corridor Light / Boiler (bf935c8cff3752fbecgfew)
- Plant Light (bffd4e253c18de762ct932)

## Known Limitations & Future Work

### Current Limitations
1. **Sensor 2 Scale Unverified**: Temp/humidity scales inferred, not confirmed by Tuya
2. **Battery State Not Stored**: Sensor 2 battery enum not persisted to DB
3. **Socket 3 Not Controllable**: Not in CONTROLLABLE_DEVICE_IDS (can be added if needed)
4. **Telemetry Staleness**: Online devices may have stale data (43+ min observed)

### Future Enhancements
1. Add Socket 3 to controllable devices if needed
2. Store battery_state field (new column or JSON field)
3. Add telemetry timestamp tracking
4. Consider real-time calibration check for Sensor 2 scales

## Migration Checklist

### Pre-Deployment ✅ Complete
- [x] Code changes minimal and surgical
- [x] All tests pass (42/42)
- [x] Documentation comprehensive
- [x] Evidence documented
- [x] Verified vs inferred mappings flagged
- [x] Grid power logic unchanged
- [x] SvitloBot logic unchanged
- [x] Backward compatibility confirmed
- [x] No DB migrations needed

### Deployment Ready ⏸️ Blocked (Per Requirements)
- [ ] PR merged (blocked: user explicitly no merge)
- [ ] Environment variables (not needed: uses default DEVICE_IDS)
- [ ] Database migrations (not needed: existing schema)
- [ ] Production deployment (blocked: user explicitly no deploy)

### Post-Deployment (When Authorized)
- [ ] Monitor new devices in production
- [ ] Verify data collection every minute
- [ ] Check API response performance
- [ ] Validate inferred Sensor 2 scales with real data
- [ ] Consider adding Socket 3 to controls

## Contact & References

- **PR**: https://github.com/yatsenkoleg-spiralsoft/power-monitor/pull/20
- **Branch**: `cursor/add-socket3-and-th-sensor2-324d`
- **Latest Commit**: 1ca16e6 "Add Socket 3 and T&H Sensor 2 to monitoring"
- **Documentation**: See DEVICES.md for complete device reference

## Appendix: Test Output

### Unit Tests (newDevices.test.js)
```
✓ Socket 3: parseStatusMap handles verified /10 scale for power and voltage
✓ Socket 3: preserves true zero power (not null)
✓ T & H Sensor 2: uses shadow API like existing sensor
✓ T & H Sensor 2: INFERRED temperature scale same as existing sensor
✓ T & H Sensor 2: battery_state is enum not percentage
✓ New devices added to DEVICE_IDS in correct order
✓ Socket 3 NOT added to SvitloBot witness or grid power logic
✓ Socket 3 specifications verified from Tuya API
✓ Sensor 2 specifications NOT available from Tuya API
✓ Real API fixture: Socket 3 online with zero power
✓ Real API fixture: Sensor 2 shadow properties
✓ Sensor 2: shadow API requires no codes filter
✓ Device online vs telemetry freshness distinction
✓ Integration: new devices stored to database with all fields
✓ Backward compatibility: existing devices unaffected
✓ API endpoint compatibility: existing response contracts unchanged
```

### Integration Tests (test/newDevicesIntegration.test.js)
```
✓ Socket 3: full API response parsing integration
✓ Socket 3: handles non-zero power consumption
✓ T & H Sensor 2: shadow API response parsing integration
    ⚠️  Temperature/humidity scale INFERRED from existing sensor, not verified by specs
✓ T & H Sensor 2: shadow API filters all properties correctly
✓ Both sensors: existing sensor logic unchanged
✓ Database storage: all new device fields map correctly
✓ Grid power logic: Socket 3 excluded from witness list
✓ SvitloBot logic: Socket 3 excluded from outage detection
✓ API response backward compatibility: /api/current format
✓ Device sort order: new devices positioned correctly
✓ Documentation: scale mappings clearly flagged
    ✓ Socket 3 scales VERIFIED by Tuya specifications API
    ⚠️  Sensor 2 scales INFERRED (specs not available, code 2009)
```

---

**Implementation Status**: ✅ Complete and Tested  
**PR Status**: 🔄 Awaiting Review  
**Deployment Status**: ⏸️ Blocked per user requirements (no merge/deploy)
