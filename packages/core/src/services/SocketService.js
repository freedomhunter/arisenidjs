import StorageService from './StorageService'
import getRandomValues from 'get-random-values';
import createHash from 'create-hash';
import WebSocket from 'isomorphic-ws';
import device from "../util/Device";

const suffix = '/socket.io/?EIO=3&transport=websocket';

let uuid;
let socket = null;
let connected = false;
let paired = false;

let plugin;
let openRequests = [];


const sha256 = data => createHash('sha256').update(data).digest('hex');

const random = () => {
    const array = new Uint8Array(24);
    getRandomValues(array);
    return array.join('');
};

const getOrigin = () => {
    let origin;
    if(typeof location !== 'undefined')
        if(location.hasOwnProperty('hostname') && location.hostname.length && location.hostname !== 'localhost')
            origin = location.hostname;
        else origin = plugin;
    else origin = plugin;
    if(origin.substr(0, 4) === 'www.') origin = origin.replace('www.','');
    return origin;
}

let appkey = StorageService.getAppKey();
if(!appkey) appkey = 'appkey:'+random();
const send = (type = null, data = null) => {
    if(type === null && data === null) socket.send('40/scatter');
    else socket.send('42/scatter,' + JSON.stringify([type, Object.assign(data, {device, uuid})]));
}

let pairingPromise = null;
const pair = (passthrough = false) => {
    return new Promise((resolve, reject) => {
        pairingPromise = {resolve, reject};
        send('pair', {data:{ appkey, origin:getOrigin(), passthrough }, plugin})
    })
};

let eventHandlers = {};

export default class SocketService {

    static init(_plugin, timeout = 60000){
        plugin = _plugin;
        this.timeout = timeout;
    }

    static getOrigin(){
        return getOrigin();
    }

    static addEventHandler(handler, key){
        if(!key) key = 'app';
	    eventHandlers[key] = handler;
    }

    static removeEventHandler(key){
	    if(!key) key = 'app';
	    delete eventHandlers[key];
    }

    static link(_uuid = null, socketHost = null){
	    uuid = _uuid;

        return Promise.race([
            new Promise((resolve, reject) => setTimeout(() => {
                if(connected) return;
                resolve(false);

                if(socket) {
                    socket.close();
                    socket = null;
                }
            }, this.timeout)),
            new Promise(async (resolve, reject) => {

                const setupSocket = () => {
                    socket.onmessage = msg => {
                        // Handshaking/Upgrading
                        if(msg.data.indexOf('42/scatter') === -1) return false;


                        // Real message
                        const [type, data] = JSON.parse(msg.data.replace('42/scatter,', ''));

                        switch(type){
                            case 'paired': return msg_paired(data);
                            case 'rekey': return msg_rekey();
                            case 'api': return msg_api(data);
                            case 'event': return event_api(data);
                        }
                    };


                    const msg_paired = result => {
                        paired = result;

                        if(paired) {
                            const savedKey = StorageService.getAppKey();
                            const hashed = appkey.indexOf('appkey:') > -1 ? sha256(appkey) : appkey;

                            if (!savedKey || savedKey !== hashed) {
                                StorageService.setAppKey(hashed);
                                appkey = StorageService.getAppKey();
                            }
                        }

                        pairingPromise.resolve(result);
                    };

                    const msg_rekey = () => {
                        appkey = 'appkey:'+random();
                        send('rekeyed', {data:{ appkey, origin:getOrigin() }, plugin});
                    };

                    const msg_api = response => {
                        const openRequest = openRequests.find(x => x.id === response.id);
                        if(!openRequest) return;

                        openRequests = openRequests.filter(x => x.id !== response.id);

                        const isErrorResponse = typeof response.result === 'object'
                            && response.result !== null
                            && response.result.hasOwnProperty('isError');

                        if(isErrorResponse) openRequest.reject(response.result);
                        else openRequest.resolve(response.result);
                    };

                    const event_api = ({event, payload}) => {
						if(Object.keys(eventHandlers).length) Object.keys(eventHandlers).map(key => {
							eventHandlers[key](event, payload);
						});
                    };
                };

                const getHostname = (port, ssl) => {
                    if(socketHost) return socketHost;
                    return ssl ? `local.get-scatter.com:${port}` : `127.0.0.1:${port}`;
                }

                const ports = await (async () => {
                    if(socketHost) return [50005];

                    const checkPort = (host, cb) => fetch(host).then(r => r.text()).then(r => cb(r === 'scatter')).catch(() => cb(false));

                    let startingPort = 50005;
                    let availablePorts = [];
	                [...new Array(5).keys()].map(i => {
		                const _port = startingPort+(i*1500);
		                return Promise.all([
			                checkPort(`https://`+getHostname(_port+1, true), x => x ? availablePorts.push(_port+1) : null),
			                checkPort(`http://`+getHostname(_port, false), x => x ? availablePorts.push(_port) : null)
		                ])
	                });

                    let tries = 0;
                    while(tries < 50){
	                    if(availablePorts.length) break;
	                    await new Promise(r => setTimeout(() => r(true),2));
	                    tries++;
                    }

                    return !availablePorts.length ?  /* BACKWARDS COMPAT */ [50006, 50005] : availablePorts.sort((a,b) => {
	                    // Always try to use SSL first.
	                    return !(b % 2) ? 1 : !(a % 2) ? -1 : 0;
                    });
                })();


                const trySocket = (port, resolver = null) => {
                    let promise;
                    if(!resolver) promise = new Promise(r => resolver = r);
	                const ssl = !(port % 2);
                    const hostname = getHostname(port, ssl);
                    const protocol = ssl ? 'wss://' : 'ws://';
                    const host = `${protocol}${hostname}${suffix}`;
                    const s = new WebSocket(host);

                    s.onerror = () => resolver(false);
                    s.onopen = () => resolver(s);

                    return promise;
                };

                for(let i = 0; i < ports.length; i++){
                    const s = await trySocket(ports[i]);
                    if(s){
	                    socket = s;
	                    send();
	                    connected = true;
	                    pair(true).then(() => resolve(true));
	                    setupSocket();
	                    break;
                    }
                }

            })
        ])
    }

    static isConnected(){
        return connected;
    }

    static isPaired(){
        return paired;
    }

    static disconnect(){
        console.log('disconnect')
        if(socket) socket.close();
        return true;
    }

    static sendApiRequest(request){
        return new Promise((resolve, reject) => {
            if(request.type === 'identityFromPermissions' && !paired) return resolve(false);

            pair().then(() => {
                if(!paired) return reject({code:'not_paired', message:'The user did not allow this app to connect to their Scatter'});

                // Request ID used for resolving promises
                request.id = random();

                // Set Application Key
                request.appkey = appkey;

                // Nonce used to authenticate this request
                request.nonce = StorageService.getNonce() || 0;
                // Next nonce used to authenticate the next request
                const nextNonce = random();
                request.nextNonce = sha256(nextNonce);
                StorageService.setNonce(nextNonce);

                if(request.hasOwnProperty('payload') && !request.payload.hasOwnProperty('origin'))
                    request.payload.origin = getOrigin();


                openRequests.push(Object.assign(request, {resolve, reject}));
                send('api', {data:request, plugin})
            })
        });
    }

}
