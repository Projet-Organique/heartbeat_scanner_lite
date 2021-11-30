require("dotenv").config();
const io = require('@pm2/io')
const { createBluetooth } = require("./src");
const axios = require('axios');
var { Timer } = require("easytimer.js");

const client = require("./mqtt")();
var timerInstance = new Timer();

let _USERBPM;
let _USER;
let _HEARTRATE;
let _PRESENCE = false;
let readyToScan = true;

client.on('connect', function () {
  client.subscribe('api/users/userpresence')
  presence.set(_PRESENCE)
})

client.on('message', function (topic, message) {
  // message is Buffer
  let buff = message.toString();
  let value = JSON.parse(buff);
  let valueParse = JSON.parse(value.presence.toLowerCase());
  _PRESENCE = valueParse
  presence.set(valueParse);
  event(valueParse);
})

const { POLAR_MAC_ADRESSE, USERS_ENDPOINT, PULSESENSORS_ENDPOINT, ID } = process.env;

const state = io.metric({
  name: 'Scanning state',
})

const polarBPM = io.metric({
  name: 'Polar BPM',
})

const presence = io.metric({
  name: 'User presence',
})

const userPicked = io.metric({
  name: 'The current selected lantern',
})

const timer = io.metric({
  name: 'The timer when the BPM is stable',
})

const error = io.metric({
  name: 'Catch error',
})

const message = io.metric({
  name: 'Global message',
})

const polarMAC = io.metric({
  name: 'Polar Mac Adress',
})
const polarName = io.metric({
  name: 'Polar device name',
})

async function init() {

  console.clear();


  const { bluetooth } = createBluetooth();
  const adapter = await bluetooth.defaultAdapter();

  if (!(await adapter.isDiscovering()))
    await adapter.startDiscovery();
  console.log("Discovering device...");

  const device = await adapter.waitDevice("A0:9E:1A:9F:0E:B4").catch((err) => {
    if (err) {
      process.exit(0);
    }
  });

  const macAdresss = await device.getAddress()
  const deviceName = await device.getName()

  console.log("got device", macAdresss, deviceName);
  polarMAC.set(macAdresss)
  polarName.set(polarName);

  await device.connect();
  console.log("Connected!");
  message.set('Connected')

  const gattServer = await device.gatt();
  //var services = await gattServer.services();

  const service = await gattServer.getPrimaryService(
    "0000180d-0000-1000-8000-00805f9b34fb"
  );
  const heartrate = await service.getCharacteristic(
    "00002a37-0000-1000-8000-00805f9b34fb"
  );
  await heartrate.startNotifications();

  _HEARTRATE = heartrate
  //checkNotification();
  message.set("Waiting for notifications")

  _HEARTRATE.on("valuechanged", async (buffer) => {
    let json = JSON.stringify(buffer);
    let bpm = Math.max.apply(null, JSON.parse(json).data);
    polarBPM.set(bpm);
  })

  
  _USER = await axios.get('http://192.168.1.15:8080/api/users/randomUser/').catch(async function (error) {
    if (error) {
      console.log(error.response.data)
      await setState(3);
      state.set("No lantern [3]");
      await sleep(2000);
      process.exit(0);
    }
  });

  userPicked.set(`User [${_USER.data.id}]`)
  await setState(0);
  message.set("Init done")
  state.set("Ready [0]");
  console.log('Ready');

}



async function event(presence) {
  // make sure to wait to be sure someone is there and its stable
  // OR USE A PRESSUR SENSOR
  if (presence) {
    if (readyToScan) {
      await setState(1);
      //_USER = await getRandomUser();
      _USERBPM = await scan();
      await axios.put('http://192.168.1.15:8080/api/users/' + _USER.data._id, { 'pulse': _USERBPM })
      await axios.put('http://192.168.1.15:8080/api/pulsesensors/s001', { 'state': 2, 'rgb': _USER.data.rgb })
      //reset();
      readyToScan = false;
      _HEARTRATE.stopNotifications();
      timerInstance.pause();
      state.set("Done [2]");
      await sleep(5000);
      process.exit(0);
    }
  }
}

/**
 * `STATE 0` = READY or IDLE
 * `STATE 1` = SCANNING
 * `STATE 2` = DONE
 * `STATE 3` = OUT OF LANTERN
 * `STATE 4` = ERROR FAILED (mainly because client presence is false while scanning)
 * Set the state of the station
 * @return {Promise<axios>} return the current bpm value
 * @param {Number} id
 */
async function setState(id) {
  return new Promise(async (resolve) => {
    await axios.put('http://192.168.1.15:8080/api/pulsesensors/s001', { 'state': id }).then(() => {
      resolve();
    })
  });
}

async function reset() {
  timerInstance.stop();
  process.exit(0);
}

async function getRandomUser() {
  return new Promise(async (resolve) => {
    await axios.get('http://192.168.1.15:8080/api/users/randomUser/').then((user) => {
      resolve(user);
    })
  });
}

/**
 * Check the BPM at his current state
 * @return {Promise<number>} return the current bpm value
 * @param {Number} ms
 */
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
/**
 * Start the BPM scan. When value is stable we launch the counter and return the last value
 * @return {Promise<number>} Last BPM after a certain time
 */
async function scan() {
  readyToScan = false;
  return new Promise(async (resolve, reject) => {
    let scanBPM;
    // await _HEARTRATE.startNotifications();
    timerInstance.addEventListener("secondsUpdated", async function (e) {
      timer.set(timerInstance.getTimeValues().toString())
      if (!_PRESENCE) {
        await setState(4);
        reset();
      }
    });
    timerInstance.addEventListener("targetAchieved", async function (e) {
      resolve(scanBPM);
    });

    _HEARTRATE.on("valuechanged", async (buffer) => {
      let json = JSON.stringify(buffer);
      let bpm = Math.max.apply(null, JSON.parse(json).data);
      polarBPM.set(bpm);
      console.log(bpm);
      if (bpm != 0) {
        scanBPM = bpm;
        await setState(1);
        state.set("Scanning [1]");
        timerInstance.start({ countdown: true, startValues: { seconds: 15 } });
      }
    })
  });
}

init();
