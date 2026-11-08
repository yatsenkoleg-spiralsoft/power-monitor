# Marstek Charge Power Display Documentation (t1307u)

**Issue ID**: t1307u  
**User Request**: "у Marstek VENUS-E 3.0 в БД есть инфа из мониторинга - marstek_charge_w - нужно отображать на карточке и в графике в приложении"  
**Translation**: Marstek VENUS-E 3.0 has monitoring data in DB - marstek_charge_w - need to display on device card and in graph in app  
**Status**: ✅ **Backend Complete** (API provides all necessary data)  
**Action Required**: Android app needs to display the field (source code not in this repository)

---

## Executive Summary

### Backend Status: ✅ COMPLETE

The backend implementation is **already complete and working correctly**:

1. ✅ Data collected from Marstek Cloud API (`charge` field)
2. ✅ Data stored in database (`marstek_charge_w` column)
3. ✅ Data exposed in API responses (`marstekChargeW` field)
4. ✅ Zero values preserved (0W ≠ null)
5. ✅ Proper semantics (charge ≠ discharge ≠ SOC)

### What Needs to Be Done

**Android App** (source not in this repository):
- Display `marstekChargeW` field on Marstek device card
- Display `marstekChargeW` in history graph
- Use correct labeling: "Заряд" / "Зарядка" / "Charging" with "Вт" / "W" units

---

## Data Flow

### Complete Path: Marstek Cloud → Database → API → Android App

```
Marstek Cloud API (eu.hamedata.com)
  ↓
  { charge: 500, ... }  // Watts
  ↓
Backend (marstek.js line 180)
  ↓
  charge = deviceState.charge  // Extract
  ↓
Database (power_status table)
  ↓
  marstek_charge_w = 500.00  // DECIMAL(10,2)
  ↓
API Response (GET /monitor, GET /api/current)
  ↓
  marstekChargeW: 500  // Number
  ↓
Android App (consuming API)
  ↓
  Display: "Заряд: 500 Вт"  ← NEED TO IMPLEMENT
```

---

## Field Specifications

### Database Column

**Table**: `power_status`  
**Column**: `marstek_charge_w`  
**Type**: `DECIMAL(10,2)`  
**Comment**: `'Marstek battery charging power в ваттах'`  
**Nullable**: Yes (NULL when data unavailable)  
**Migration**: `sql/migration_add_marstek.sql`

```sql
ALTER TABLE `power_status` 
ADD COLUMN IF NOT EXISTS `marstek_charge_w` DECIMAL(10,2) DEFAULT NULL 
COMMENT 'Marstek battery charging power в ваттах' 
AFTER `marstek_soc_percent`;
```

### API Field

**Field Name**: `marstekChargeW`  
**Type**: `number | null`  
**Unit**: Watts (W)  
**Semantics**: Power flowing INTO battery (charging)  
**Range**: 0 to ~3000W (typical max for VENUS-E 3.0)  
**Endpoints**: 
- `GET /monitor` (live data)
- `GET /api/current` (latest DB snapshot)

### Marstek Cloud API Source

**Endpoint**: `https://eu.hamedata.com/ems/api/v1/getDeviceList`  
**Field**: `charge`  
**Type**: Number  
**Unit**: Watts  
**Description**: Battery charging power

---

## Field Semantics

### Three Distinct Concepts

| Field | Meaning | Unit | Example | Display |
|-------|---------|------|---------|---------|
| `marstekSocPercent` | State of Charge (battery level) | % | 75 | "75%" |
| `marstekChargeW` | Charging power (INTO battery) | W | 500 | "Заряд: 500 Вт" |
| `marstekDischargeW` | Discharging power (OUT OF battery) | W | 0 | "Розряд: 0 Вт" |

**Critical**: Do NOT conflate these three measurements!

### Charge vs Discharge

- **Charge** (`marstekChargeW`): Power **flowing INTO** battery
  - Positive when battery is being charged
  - Zero when not charging
  - Typically 0-3000W for VENUS-E 3.0

- **Discharge** (`marstekDischargeW`): Power **flowing OUT OF** battery  
  - Positive when battery is supplying power
  - Zero when not discharging
  - Typically 0-3000W for VENUS-E 3.0

- **Mutual Exclusivity**: Battery is usually either charging OR discharging, not both
  - Charging: `charge > 0`, `discharge = 0`
  - Discharging: `charge = 0`, `discharge > 0`
  - Idle: `charge = 0`, `discharge = 0`

### SOC (State of Charge)

- **SOC** (`marstekSocPercent`): Battery level percentage
  - Always 0-100%
  - Independent of charge/discharge power
  - Can be at 50% while charging at 1000W
  - Can be at 50% while discharging at 500W

---

## Zero vs Null Handling

### Zero is Valid (Not Charging)

```javascript
{
  marstekChargeW: 0  // Battery not charging (valid state)
}
```

**Display**: "Заряд: 0 Вт" or "0 W"

### Null is Missing Data

```javascript
{
  marstekChargeW: null  // Data unavailable
}
```

**Display**: "—" or hide the field

### Distinction is Important

| Value | Meaning | Display |
|-------|---------|---------|
| `0` | Not charging (explicit state) | "0 Вт" |
| `null` | Data missing/unavailable | "—" or hidden |

**Do NOT** replace 0 with null or vice versa!

---

## Android App Integration Guide

### Device Card Display

**Location**: Marstek VENUS-E 3.0 device card  
**Field**: `marstekChargeW` from API response  
**Label**: "Заряд" or "Зарядка" (Russian) / "Charging" (English)  
**Unit**: "Вт" (Russian) / "W" (English)  
**Format**: `{value} Вт`

**Example**:
```
Marstek VENUS-E 3.0
━━━━━━━━━━━━━━━━━━━
Заряд: 75%           ← marstekSocPercent
Зарядка: 500 Вт      ← marstekChargeW (THIS FIELD)
Розряд: 0 Вт         ← marstekDischargeW
Нагрузка: 200 Вт     ← marstekLoadW
PV: 700 Вт           ← marstekPvW
```

### History Graph

**Graph Type**: Time series line chart  
**Y-Axis**: Power (Watts)  
**X-Axis**: Time  
**Line**: Charging power over time  
**Color**: Distinct from discharge/load/PV (suggest green or blue)

**Data Source**:
- Endpoint: `GET /api/minute?deviceId=marstek&startDate=YYYY-MM-DD&endDate=YYYY-MM-DD`
- Field: `marstek_charge_w` (snake_case in minute data)
- Or: Parse from full device history

**Example Graph**:
```
Watts
3000 ┤
2500 ┤
2000 ┤     ╭───╮
1500 ┤   ╭─╯   ╰─╮
1000 ┤  ╭╯       ╰╮
 500 ┤╭─╯         ╰─╮
   0 ┼────────────────────
     00:00  06:00  12:00  18:00
     
Legend:
─── Зарядка (Charge)  ← marstekChargeW
```

### API Response Structure

**GET /monitor** response:
```json
{
  "success": true,
  "devices": [
    {
      "deviceId": "marstek",
      "deviceName": "Marstek VENUS-E 3.0",
      "deviceSn": "VNSE3-12345",
      "isOnline": true,
      "marstekSocPercent": 75,
      "marstekChargeW": 500,        ← USE THIS FIELD
      "marstekDischargeW": 0,
      "marstekLoadW": 200,
      "marstekPvW": 700,
      "marstekGridW": 0,
      "marstekReportTime": "2026-11-08T17:30:00.000Z"
    }
  ]
}
```

**GET /api/current** response (same structure).

---

## Real-World Scenarios

### Scenario 1: Charging from Grid

```javascript
{
  marstekSocPercent: 45,
  marstekChargeW: 1000,   // ← Charging at 1000W
  marstekDischargeW: 0,   // Not discharging
  marstekGridW: 1000,     // Drawing from grid
  marstekPvW: 0,          // No solar
  marstekLoadW: 0         // No load
}
```

**Display**:
- Заряд: 45%
- **Зарядка: 1000 Вт** ← Show this
- Розряд: 0 Вт

### Scenario 2: Charging from Solar

```javascript
{
  marstekSocPercent: 60,
  marstekChargeW: 500,    // ← Charging at 500W from excess solar
  marstekDischargeW: 0,
  marstekGridW: 0,
  marstekPvW: 700,        // 700W solar: 500W→battery, 200W→load
  marstekLoadW: 200
}
```

**Display**:
- Заряд: 60%
- **Зарядка: 500 Вт** ← Show this
- PV: 700 Вт
- Нагрузка: 200 Вт

### Scenario 3: Discharging (Not Charging)

```javascript
{
  marstekSocPercent: 80,
  marstekChargeW: 0,      // ← NOT charging
  marstekDischargeW: 300, // Discharging at 300W
  marstekLoadW: 300
}
```

**Display**:
- Заряд: 80%
- **Зарядка: 0 Вт** ← Show zero (not hidden)
- Розряд: 300 Вт

### Scenario 4: Idle (Neither Charging nor Discharging)

```javascript
{
  marstekSocPercent: 95,
  marstekChargeW: 0,      // ← Not charging
  marstekDischargeW: 0,   // Not discharging
  marstekPvW: 0,
  marstekLoadW: 0
}
```

**Display**:
- Заряд: 95%
- **Зарядка: 0 Вт** ← Show zero (battery full/idle)
- Розряд: 0 Вт

---

## Implementation Verification

### Backend Code References

**Data Collection**: `marstek.js` line 180
```javascript
const charge = deviceState.charge != null ? Number(deviceState.charge) : null;
```

**Database Storage**: `db.js` line 79
```javascript
marstekChargeW,  // Parameter in savePowerStatus()
```

**Database Read**: `db.js` line 577
```javascript
ps.marstek_charge_w,  // Read from power_status table
```

**API Mapping (DB → API)**: `index.js` line 186
```javascript
marstekChargeW: row.marstek_charge_w != null ? Number(row.marstek_charge_w) : null,
```

**API Mapping (Live → API)**: `index.js` line 598
```javascript
marstekChargeW: device.charge,
```

### Test Coverage

**Test File**: `test/marstekChargeDisplay.test.js`  
**Tests**: 18 comprehensive tests

1. ✅ Data stored in database
2. ✅ API field name mapping
3. ✅ Field semantics distinctions
4. ✅ Preserve valid zero (not null)
5. ✅ Distinguish zero from missing
6. ✅ Units are watts not percentage
7. ✅ Typical values validation
8. ✅ Charge vs discharge mutual exclusivity
9. ✅ API response includes marstekChargeW
10. ✅ Database to API field mapping
11. ✅ Marstek API to backend mapping
12. ✅ Full data flow validation
13. ✅ Display labeling guidance
14. ✅ Negative values handling
15. ✅ Fractional watts precision
16. ✅ Real-world scenarios
17. ✅ Android display requirements summary
18. ✅ Backend implementation already complete

**All tests pass**: 18/18 ✅

---

## Comparison with Other Fields

### Similar Pattern: EcoFlow Output Power

**Issue**: EcoFlow was also missing output power display  
**Fix**: Added fallback field names in `ecoflow.js`  
**Lesson**: Backend provides data, Android app needs to consume it

### Marstek is Different

**EcoFlow Issue**: Backend wasn't extracting the right fields  
**Marstek Issue**: Backend already extracts and exposes everything correctly

**Marstek Status**: ✅ No backend changes needed!

---

## Browser Site Status

User note: "Current browser site Marstek SOC styling is already independently done; do not alter it."

**Understood**: 
- Browser frontend (samber.in.ua/roz) may be maintained separately
- May be in `C:\PRJ_my\roz` (not in this repository)
- No changes made to browser site styling
- **This documentation is for Android app only**

---

## Labeling Conventions

### Correct Labels (Use These)

**Russian**:
- "Заряд: X Вт" (Charge: X W)
- "Зарядка: X Вт" (Charging: X W)
- "Мощность зарядки: X Вт" (Charging power: X W)

**English**:
- "Charge: X W"
- "Charging: X W"
- "Charge Power: X W"

### Incorrect Labels (Avoid These)

❌ "Заряд: X%" → Wrong unit (% instead of W)  
❌ "Розряд: X Вт" → Wrong field (discharge instead of charge)  
❌ "SOC: X" → Wrong field (battery level instead of charge power)  
❌ "Battery: X W" → Ambiguous (could be charge or discharge)

---

## Typical Value Ranges

**VENUS-E 3.0 Specifications**:
- Battery Capacity: Typically 3-5 kWh models
- Max Charge Power: ~3000W (varies by model)
- Max Discharge Power: ~3000W (varies by model)

**Expected Charge Power Values**:
- `0 W` → Not charging (idle or discharging)
- `0-500 W` → Low charge rate
- `500-1500 W` → Medium charge rate
- `1500-3000 W` → High charge rate
- `>3000 W` → Unlikely (check for data error)

**Negative Values**: Should not occur (charge is power INTO battery, always ≥ 0)

---

## Testing in Android App

### Manual Test Steps

1. **Backend Verification**:
   ```bash
   curl https://your-api.run.app/monitor | jq '.devices[] | select(.deviceId == "marstek")'
   ```
   - Verify `marstekChargeW` field is present
   - Verify value is numeric or null

2. **Android App Check**:
   - Open Marstek device card
   - Look for charging power display
   - Verify unit is "Вт" or "W" (not "%")
   - Verify label is "Заряд" or "Зарядка" (not "Розряд")

3. **Graph Check**:
   - Open Marstek history graph
   - Look for charging power line
   - Verify Y-axis label is watts
   - Verify line color distinguishes from discharge

### Test Scenarios

**Scenario A**: Battery charging from solar at 700W
- Expected: "Зарядка: 700 Вт" displayed
- Expected: Graph shows upward trend

**Scenario B**: Battery not charging (idle at 95%)
- Expected: "Зарядка: 0 Вт" displayed (not hidden)
- Expected: Graph shows flat line at zero

**Scenario C**: Data unavailable (API returns null)
- Expected: "Зарядка: —" or field hidden
- Expected: Graph shows gap

---

## Migration Notes

### No Backend Migration Needed

✅ Database column already exists  
✅ API already exposes field  
✅ Data already being collected  
✅ Zero handling already correct

### Android App Update Required

**What to Add**:
1. Display `marstekChargeW` on device card
2. Display `marstekChargeW` in history graph
3. Use correct labeling and units

**What NOT to Change**:
- Browser site Marstek SOC styling
- Backend API structure
- Database schema
- Data collection logic

---

## Troubleshooting

### If Charge Power Shows as Null

**Possible Causes**:
1. Marstek device offline
2. Marstek cloud API not responding
3. Authentication expired
4. Device not reporting charge data

**Check**:
```bash
# Backend logs
grep "Marstek" /path/to/logs

# API response
curl https://api/monitor | jq '.devices[] | select(.deviceId == "marstek")'
```

### If Charge Power Shows Wrong Value

**Possible Causes**:
1. Conflated with discharge (`marstekDischargeW`)
2. Conflated with SOC (`marstekSocPercent`)
3. Unit error (showing % instead of W)

**Verify Android App**:
- Uses `marstekChargeW` field (not `marstekDischargeW` or `marstekSocPercent`)
- Displays with "Вт" or "W" unit (not "%")
- Label says "Заряд" or "Зарядка" (not "Розряд" or "SOC")

---

## Summary Checklist

### Backend (Already Complete ✅)

- [x] Marstek Cloud API integration
- [x] `charge` field extraction
- [x] Database column `marstek_charge_w`
- [x] API field `marstekChargeW`
- [x] Zero preservation (0 ≠ null)
- [x] Proper semantics (charge ≠ discharge ≠ SOC)
- [x] Test coverage (18 tests)
- [x] Documentation

### Android App (To Be Implemented)

- [ ] Display `marstekChargeW` on device card
- [ ] Use label "Заряд" / "Зарядка" / "Charging"
- [ ] Use unit "Вт" / "W"
- [ ] Display `marstekChargeW` in history graph
- [ ] Graph Y-axis labeled as Watts
- [ ] Distinct color from discharge/load/PV
- [ ] Handle zero (display "0 Вт", not hide)
- [ ] Handle null (display "—" or hide)

---

## References

- **PR**: https://github.com/yatsenkoleg-spiralsoft/power-monitor/pull/20
- **Branch**: `cursor/add-socket3-and-th-sensor2-324d`
- **Backend Code**:
  - `marstek.js` (data collection)
  - `db.js` (database storage/retrieval)
  - `index.js` (API exposure)
- **Tests**: `test/marstekChargeDisplay.test.js` (18 tests)
- **Migration**: `sql/migration_add_marstek.sql`

---

**Backend Status**: ✅ Complete  
**API Status**: ✅ Ready  
**Android App**: ⏸️ Needs implementation (source not in this repo)  
**No APK Build**: Per user instruction (code changes only, no app build)
