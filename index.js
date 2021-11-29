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
})

client.on('message', function (topic, message) {
  // message is Buffer
  let buff = message.toString();
  let value = JSON.parse(buff);
  let valueParse = JSON.parse(value.presence.toLowerCase());
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

const polarState = io.metric({
  name: 'Check if polar is on or off',
})


async function connectDevice(){
  return new Promise(async (resolve) => {

    const { bluetooth } = createBluetooth();
    const adapter = await bluetooth.defaultAdapter();
  
    if (!(await adapter.isDiscovering()))
      await adapter.startDiscovery();
    console.log("Discovering device...");
  
    const device = await adapter.waitDevice("A0:9E:1A:9F:0E:B4").catch((err)=>{
      if(err){
        process.exit(0);
      }
    });
    console.log("got device", await device.getAddress(), await device.getName());
    await device.connect();
    console.log("Connected!");
  
    const gattServer = await device.gatt();
    //var services = await gattServer.services();
  
    const service = await gattServer.getPrimaryService(
      "0000180d-0000-1000-8000-00805f9b34fb"
    );
    const heartrate = await service.getCharacteristic(
      "00002a37-0000-1000-8000-00805f9b34fb"
    );

    _HEARTRATE = heartrate
    polarState.set("On")
    resolve();
  });
}

async function checkNotification(){
  setInterval(async function(){ 
    await _HEARTRATE.isNotifying().catch(async (e)=>{
      if(e){
        console.log(e.text)
          polarState.set("Off")
          await connectDevice();
          //process.exit(1);
      }
    }); 
  }, 1000);
}

async function init() { 

  console.clear();

  await connectDevice();
  await checkNotification();
  await _HEARTRATE.startNotifications();

  _HEARTRATE.on("valuechanged", async (buffer) => {
    let json = JSON.stringify(buffer);
    let bpm = Math.max.apply(null, JSON.parse(json).data);
    polarBPM.set(bpm);
  })

  _USER = await axios.get('http://192.168.1.15:8080/api/users/randomUser/').catch(async function (error) {
    if (error) {
      console.log(error.response.data)
      setState(3);
      state.set(`No lantern [${3}]`);
      await sleep(5000);
      process.exit(0);
    }
  });

  userPicked.set(`User [${_USER.data.id}]`)
  setState(0);
  state.set(`Ready [${0}]`);
  console.log('Ready');

}



async function event(presence) {
  // make sure to wait to be sure someone is there and its stable
  // OR USE A PRESSUR SENSOR
  if (presence) {
    if (readyToScan) {
      setState(1);
      //_USER = await getRandomUser();
      _USERBPM = await scan();
      await axios.put('http://192.168.1.15:8080/api/users/' + _USER.data._id, { 'pulse': _USERBPM })
      await axios.put('http://192.168.1.15:8080/api/pulsesensors/s001', { 'state': 2, 'rgb': _USER.data.rgb })
      //reset();
      readyToScan = false;
      _HEARTRATE.stopNotifications();
      timerInstance.pause();
      state.set(`Done [${2}]`);
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
  await axios.put('http://192.168.1.15:8080/api/pulsesensors/s001', { 'state': id })
}

async function reset() {
  setState(4);
  timerInstance.stop();
  //await sleep(1000);
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
    timerInstance.addEventListener("secondsUpdated", function (e) {
      timer.set(timerInstance.getTimeValues().toString())
      console.log(timerInstance.getTimeValues().toString());
      if(!_PRESENCE){
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
        setState(1);
        state.set(`Scanning [${1}]`);
        timerInstance.start({ countdown: true, startValues: { seconds: 15 } });
      }
    })
  });
}

init();
