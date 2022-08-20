import { MediaStreamTrack, RTCPeerConnection } from "@koush/werift";
import { connectRTCSignalingClients } from "@scrypted/common/src/rtc-signaling";
import { Intercom, RequestMediaStream, RTCAVSignalingSetup, RTCSignalingSession } from "@scrypted/sdk";
import { turnServer } from "./ice-servers";
import { waitConnected } from "./peerconnection-util";
import { createTrackForwarder, parseOptions } from "./rtc-bridge";
import { ScryptedSessionControl } from "./session-control";
import { requiredAudioCodecs, requiredVideoCodec } from "./webrtc-required-codecs";
import { WeriftSignalingSession } from "./werift-signaling-session";
import { isPeerConnectionAlive, logIsPrivateIceTransport } from "./werift-util";

function createSetup(audioDirection: RTCRtpTransceiverDirection, videoDirection: RTCRtpTransceiverDirection): Partial<RTCAVSignalingSetup> {
    return {
        configuration: {
            iceServers: [
                turnServer,
            ],
        },
        audio: {
            direction: audioDirection,
        },
        video: {
            direction: videoDirection,
        },
    }
};

export async function createRTCPeerConnectionSink(
    clientSignalingSession: RTCSignalingSession,
    console: Console,
    intercom: Intercom,
    maximumCompatibilityMode: boolean,
    requestMediaStream: RequestMediaStream,
) {
    const { transcodeWidth, sessionSupportsH264High } = parseOptions(await clientSignalingSession.getOptions());

    const hasIntercom = !!intercom;

    const cameraAudioDirection = hasIntercom
        ? 'sendrecv'
        : 'sendonly';

    const videoCodecs = [
        requiredVideoCodec,
    ];

    /*
    if (mediaStreamOptions?.sdp) {
        // this path is here for illustrative purposes, and is unused
        // because this code always supplies an answer.
        // it could be useful in the offer case, potentially.
        // however, it seems that browsers ignore profile-level-id
        // that are not exactly what they are expecting for
        // baseline or high.
        // seems better to use the browser offer to determine the capability
        // set to see if a codec copy is possible.
        const fmtps = findFmtp(mediaStreamOptions.sdp, 'H264/90000');
        if (fmtps?.length === 1) {
            const fmtp = fmtps[0];

            const nativeVideoCodec = new RTCRtpCodecParameters({
                mimeType: "video/H264",
                clockRate: 90000,
                rtcpFeedback: [
                    { type: "transport-cc" },
                    { type: "ccm", parameter: "fir" },
                    { type: "nack" },
                    { type: "nack", parameter: "pli" },
                    { type: "goog-remb" },
                ],
                parameters: fmtp.fmtp,
            });

            videoCodecs.unshift(nativeVideoCodec);
        }
    }
    */

    const pc = new RTCPeerConnection({
        // werift supports ice servers, but it seems to fail for some reason.
        // it does not matter, as we can send the ice servers to the browser instead.
        // the cameras and alexa targets will also provide externally reachable addresses.
        codecs: {
            audio: [
                ...requiredAudioCodecs,
            ],
            video: videoCodecs,
        }
    });

    const vtrack = new MediaStreamTrack({
        kind: "video", codec: requiredVideoCodec,
    });
    const videoTransceiver = pc.addTransceiver(vtrack, {
        direction: 'sendonly',
    });

    const atrack = new MediaStreamTrack({ kind: "audio" });
    const audioTransceiver = pc.addTransceiver(atrack, {
        direction: cameraAudioDirection,
    });

    const forwarderPromise = (async () => {
        const timeStart = Date.now();

        await waitConnected(pc);

        console.log('connected', Date.now() - timeStart);

        const isPrivate = logIsPrivateIceTransport(console, pc);
        return createTrackForwarder(timeStart, isPrivate,
            requestMediaStream,
            videoTransceiver, audioTransceiver,
            sessionSupportsH264High, maximumCompatibilityMode, transcodeWidth);
    })();

    forwarderPromise.then(f => f.killPromise.finally(cleanup));

    const cleanup = async () => {
        // no need to explicitly stop intercom as the server closing will terminate it.
        // do this to prevent shared intercom clobbering.
        await Promise.allSettled([
            pc?.close(),
            forwarderPromise?.then(f => f.kill()),
        ]);
    };

    pc.connectionStateChange.subscribe(() => {
        console.log('connectionStateChange', pc.connectionState);
        if (!isPeerConnectionAlive(pc))
            cleanup();
    });
    pc.iceConnectionStateChange.subscribe(() => {
        console.log('iceConnectionStateChange', pc.iceConnectionState);
        if (!isPeerConnectionAlive(pc))
            cleanup();
    });

    const cameraSignalingSession = new WeriftSignalingSession(console, pc);

    const clientAudioDirection = hasIntercom
        ? 'sendrecv'
        : 'recvonly';

    connectRTCSignalingClients(console,
        clientSignalingSession, createSetup(clientAudioDirection, 'recvonly'),
        cameraSignalingSession, createSetup(cameraAudioDirection, 'sendonly'));

    return new ScryptedSessionControl(cleanup, intercom, audioTransceiver);
}
