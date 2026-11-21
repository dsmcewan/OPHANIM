import {run} from 'node:test';
const stream=run({files:['ophanim/operate/independence.test.mjs','ophanim/operate/validator-identity.test.mjs','ophanim/operate/revision-reassessment.test.mjs','ophanim/operate/fit-lifecycle.test.mjs'],isolation:'none'});
stream.on('test:fail',e=>process._rawDebug('FAIL '+e.name+' '+(e.details?.error?.stack??JSON.stringify(e.details))));
stream.on('test:summary',e=>process._rawDebug('SUMMARY '+JSON.stringify(e)));
stream.resume();
