# Marstek Cloud API Resilience Implementation

## Problem Statement
The Android app occasionally shows Marstek as offline with error "Marstek VENUS-E 3.0 device not found in account". This was observed at 2026-11-09 14:32 UTC where the cloud API temporarily returned an empty device list, despite working normally seconds before and after.

## Root Cause Analysis
The original implementation:
1. Made a single attempt to fetch device list from Marstek cloud API
2. Threw an error immediately if the VNSE3-0 device was not found in the response
3. Did not distinguish between permanent failures and transient cloud API issues
4. Only handled code 8 (token expired) explicitly
5. No fallback mechanism for temporary cloud unavailability

## Solution Architecture

### 1. Grace Period Caching (15 minutes)
```javascript
const GRACE_PERIOD_MS = 15 * 60 * 1000; // 15 minutes
let lastGoodReading = { state: null, cachedAt: 0 };
```

**Behavior:**
- Every successful fetch updates `lastGoodReading` cache
- On failure, if cache is within grace period, serve from cache
- Device remains online (not marked offline) during grace period
- Error field indicates: "Using cached data (cloud temporarily unavailable)"

**Benefits:**
- Eliminates false offline alerts for transient failures
- Provides continuity of service during brief cloud outages
- 15-minute window balances freshness vs. resilience

### 2. Automatic Retry with Re-login

**Retry Logic:**
```javascript
const MAX_RETRIES = 1;
let retryCount = 0;

while (retryCount <= MAX_RETRIES) {
    // Attempt fetch
    // On failure: re-login and retry
    // On device not found: re-login and retry
}
```

**Triggers for Retry:**
1. Missing device in response (empty list or wrong device type)
2. Unexpected cloud response codes (not code 1 or 8)
3. Network errors or timeouts

**Retry Strategy:**
- Always force fresh login on retry (invalidate cached token)
- Maximum 1 retry (total 2 attempts) to avoid excessive API calls
- Falls back to grace period cache if all retries exhausted

### 3. Enhanced Response Handling

**Explicit Code Handling:**
```javascript
// code 1 = ok/success (observed in production)
if (data && data.code === 1 && Array.isArray(data.data)) {
    return { devices: data.data, rawCode, rawMsg };
}

// code 8 = token expired (already handled)
if (data && data.code === 8) {
    throw new Error('TOKEN_EXPIRED');
}

// Any other code = unexpected, log and retry
console.warn(`Marstek getDeviceList unexpected response: code=${rawCode}, msg=${rawMsg}`);
```

**Benefits:**
- Captures diagnostic information for unknown response codes
- Helps identify new failure modes in production
- No secrets or tokens in logs

### 4. Diagnostic Logging

**What Gets Logged:**
- ✅ Raw cloud response codes and messages
- ✅ Device count in response
- ✅ Cache age when serving from grace period
- ✅ Retry attempts and outcomes
- ❌ Tokens, passwords, or other secrets

**Example Logs:**
```
Marstek VENUS-E 3.0 device not found. Cloud response: code=1, msg=ok, deviceCount=0
Marstek device not found, re-logging in and retrying...
Marstek device not found after retry. Serving last good reading from 120s ago (within grace period).
```

## Implementation Details

### Changes to `marstek.js`

1. **New Grace Period Cache:**
   - Separate from short TTL cache (30s)
   - Only updated on successful fetches
   - Checked on all failures before throwing error

2. **Modified `getDeviceStatus()` Return Value:**
   ```javascript
   // Before: return Array
   return data.data;
   
   // After: return Object with metadata
   return { 
       devices: data.data, 
       rawCode: data?.code, 
       rawMsg: data?.msg 
   };
   ```

3. **Enhanced `fetchMarstekStatus()` with Retry Loop:**
   - Wraps entire fetch logic in retry loop
   - Handles device-not-found separately from other errors
   - Checks grace period cache before throwing

4. **Updated `getMarstekDataForAllDevices()` Return Type:**
   - Added `fromGracePeriod: boolean` field
   - Sets error message when serving from cache
   - Maintains backward compatibility

### Changes to `index.js`

1. **Destructure `fromGracePeriod` from Marstek result:**
   ```javascript
   const { deviceId, deviceName, soc, charge, discharge, load, pv, grid, reportTime, error, fromGracePeriod } = device;
   ```

2. **Add grace period indicator to logs:**
   ```javascript
   if (fromGracePeriod) parts.push('(кеш: облако временно недоступно)');
   ```

3. **Pass through `fromGracePeriod` in live API response:**
   ```javascript
   fromGracePeriod: device.fromGracePeriod || false,
   ```

### New Test Suite: `test/marstek.test.js`

**Test Coverage:**
1. ✅ Successful device fetch
2. ✅ Token expiration triggers re-login and retry
3. ✅ Missing device triggers re-login and retry
4. ✅ Transient failure serves from grace period
5. ✅ Failure beyond grace period throws error
6. ✅ Unexpected cloud response code is logged
7. ✅ Cache prevents redundant API calls
8. ✅ No credentials returns empty array
9. ✅ isMarstekEnabled checks credentials
10. ✅ getPollIntervalMs returns configured value

**Test Implementation:**
- Mocks axios to simulate various cloud API responses
- Captures console output for verification
- Tests grace period behavior with cached readings
- Verifies retry logic and re-login triggers

## Deployment Impact

### Backward Compatibility
✅ **Fully backward compatible**
- Existing behavior preserved for normal operation
- API response structure extended (not changed)
- No breaking changes to function signatures
- All existing tests continue to pass

### Performance Impact
✅ **Minimal performance impact**
- One additional retry on transient failures only
- Grace period check is simple timestamp comparison
- No impact on successful fetches
- Cache prevents redundant API calls

### Operational Benefits
1. **Reduced False Alarms:** No more offline alerts for transient issues
2. **Better Diagnostics:** Cloud response codes logged for analysis
3. **Service Continuity:** 15-minute grace period bridges temporary outages
4. **Self-Healing:** Automatic retry with re-login resolves most issues

### Monitoring Recommendations
1. Monitor for grace period usage in logs (indicates cloud instability)
2. Track frequency of "unexpected response code" warnings
3. Alert if grace period is used frequently (may indicate persistent issue)
4. Consider increasing grace period if transient issues are common

## Testing Evidence

```bash
$ npm test
> node newDevices.test.js && node test/newDevicesIntegration.test.js && 
  node svitlobot.test.js && node alertPush.test.js && 
  node scheduleDiff.test.js && node test/minuteQuery.test.js && 
  node test/marstek.test.js

# All 69 tests passed
# Including 10 new Marstek resilience tests
```

## Scenarios Handled

### Scenario 1: Empty Device List (Observed Issue)
**Before:** Immediate error, device marked offline  
**After:** Re-login + retry → if still empty, serve from grace period (15 min)

### Scenario 2: Token Expired (Code 8)
**Before:** Re-login and retry once  
**After:** Same behavior (unchanged)

### Scenario 3: Unexpected Response Code (e.g., code 99)
**Before:** Returns empty array, device not found error  
**After:** Log warning + re-login + retry → grace period fallback

### Scenario 4: Network Timeout
**Before:** Exception thrown, device marked offline  
**After:** Retry once → grace period fallback → error if expired

### Scenario 5: Cloud Maintenance (Extended Outage)
**Before:** Device immediately marked offline  
**After:** Serve from grace period for up to 15 minutes, then error

## Future Enhancements (Not in Scope)

1. **Exponential Backoff:** Could add delay between retries
2. **Configurable Grace Period:** Make 15 minutes an env var
3. **Metrics/Telemetry:** Track retry rates and grace period usage
4. **Health Check Endpoint:** Expose grace period status in API
5. **Multiple Device Support:** Handle accounts with multiple VNSE3-0 devices

## Conclusion

This implementation transforms Marstek integration from brittle to resilient:
- **Handles transient failures gracefully** via grace period caching
- **Self-heals** via automatic retry with fresh authentication
- **Provides visibility** via enhanced diagnostic logging
- **Maintains backward compatibility** while adding robustness
- **Fully tested** with comprehensive test suite

The solution specifically addresses the observed issue of occasional empty device lists while building general resilience for any transient cloud API failures.
