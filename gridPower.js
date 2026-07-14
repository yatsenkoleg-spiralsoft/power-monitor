const SOCKET2_DEVICE_ID = 'bfcbd371e1af7827f9sj79';
const ECOFLOW_DEVICE_ID = 'ecoflow';
const GRID_VOLTAGE_THRESHOLD = 50;

/**
 * @param {boolean|undefined|null} isOnline
 * @param {number|null|undefined} voltageV
 * @returns {boolean|null} true=grid present, false=absent, null=unknown
 */
function computeGridPresent(isOnline, voltageV) {
    if (!isOnline) {
        return false;
    }
    if (voltageV === null || voltageV === undefined || Number.isNaN(Number(voltageV))) {
        return null;
    }
    return Number(voltageV) >= GRID_VOLTAGE_THRESHOLD;
}

module.exports = {
    SOCKET2_DEVICE_ID,
    ECOFLOW_DEVICE_ID,
    GRID_VOLTAGE_THRESHOLD,
    computeGridPresent,
};
