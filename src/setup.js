const core = require('@actions/core');
const exec = require('@actions/exec');
const tc = require('@actions/tool-cache');
const path = require('path');
const fs = require('fs');

function log(...args) {
    console.log(...args);
}

async function run() {
    try {
        let unityVersion = core.getInput('unity-version');
        let unityVersionChangeset = core.getInput('unity-version-changeset');
        const unityModules = getInputAsArray('unity-modules');
        const unityModulesChild = getInputAsBool('unity-modules-child');
        const installPath = core.getInput('install-path');
        const projectPath = core.getInput('project-path');
        const selfHosted = getInputAsBool('self-hosted');

        log("Inputs:",
        "\nunityVersion:", unityVersion,
        "\nunityVersionChangeset:", unityVersionChangeset,
        "\nunityModules:", unityModules,
        "\nunityModulesChild:", unityModulesChild,
        "\ninstallPath:", installPath,
        "\nprojectPath:", projectPath,
        "\nselfHosted:", selfHosted
        );

        if (!unityVersion) {
            log("Can't get unityVersion from input");
            [unityVersion, unityVersionChangeset] = await findProjectVersion(projectPath);
            log("Found in project unityVersionChangeset:", unityVersionChangeset, "unityVersion:", unityVersion);
        } else if (!unityVersionChangeset) {
            unityVersionChangeset = await findVersionChangeset(unityVersion);
        }
        const unityHubPath = await installUnityHub(selfHosted);
        const unityPath = await installUnityEditor(unityHubPath, installPath, unityVersion, unityVersionChangeset, selfHosted);
        if (unityModules.length > 0) {
            await installUnityModules(unityHubPath, unityVersion, unityModules, unityModulesChild);
        }
        
        core.setOutput('unity-version', unityVersion);
        core.setOutput('unity-path', unityPath);
        core.exportVariable('UNITY_PATH', unityPath);
        core.exportVariable('UNITY_VERSION', unityVersion);
    } catch (error) {
        core.setFailed(error.message);
    }
}

async function installUnityHub(selfHosted) {
    log("Define unityHubPath on platform:", process.platform);
    let unityHubPath = '';
    if (process.platform === 'linux') {

        unityHubPath = `${process.env.HOME}/Unity Hub/UnityHub.AppImage`;
        if (!fs.existsSync(unityHubPath)) {
            log("Installing Unity Hub...");
            const installerPath = await tc.downloadTool('https://public-cdn.cloud.unity3d.com/hub/prod/UnityHub.AppImage');
            await execute(`mkdir -p "${process.env.HOME}/Unity Hub" "${process.env.HOME}/.config/Unity Hub"`);
            await execute(`mv "${installerPath}" "${unityHubPath}"`);
            await execute(`chmod +x "${unityHubPath}"`);
            await execute(`touch "${process.env.HOME}/.config/Unity Hub/eulaAccepted"`);
            try {
                await execute('apt-get update', { sudo: !selfHosted });
                await execute('apt-get install -y libgconf-2-4 libglu1 libasound2 libgtk2.0-0 libgtk-3-0 libnss3 zenity xvfb', { sudo: !selfHosted });
                log("Unity Hub successfully installed");
            } catch {
                // skip 'command not found' error
                log("Unity Hub installed with errors");
            }
        } else {
            log("Unity Hub is already installed in:", unityHubPath);
        }

    } else if (process.platform === 'darwin') {

        unityHubPath = '/Applications/Unity Hub.app/Contents/MacOS/Unity Hub';
        if (!fs.existsSync(unityHubPath)) {
            log("Installing Unity Hub...");
            const installerPath = await tc.downloadTool('https://public-cdn.cloud.unity3d.com/hub/prod/UnityHubSetup.dmg');
            await execute(`hdiutil mount "${installerPath}"`, { sudo: !selfHosted });
            const hubVolume = (await execute('ls /Volumes')).match(/Unity Hub.*/)[0];
            await execute(`ditto "/Volumes/${hubVolume}/Unity Hub.app" "/Applications/Unity Hub.app"`);
            await execute(`hdiutil detach "/Volumes/${hubVolume}"`, { sudo: !selfHosted });
            await execute(`rm "${installerPath}"`);
            log("Unity Hub successfully installed");
        } else {
            log("Unity Hub is already installed in:", unityHubPath);
        }

    } else if (process.platform === 'win32') {

        unityHubPath = 'C:/Program Files/Unity Hub/Unity Hub.exe';
        if (!fs.existsSync(unityHubPath)) {
            log("Installing Unity Hub...");
            const installerPath = await tc.downloadTool('https://public-cdn.cloud.unity3d.com/hub/prod/UnityHubSetup.exe');
            await execute(`"${installerPath}" /s`);
            await execute(`del "${installerPath}"`);
            log("Unity Hub successfully installed");
        } else {
            log("Unity Hub is already installed in:", unityHubPath);
        }

    } else {
        throw new Error('Unknown platform');
    }
    return unityHubPath;
}

async function installUnityEditor(unityHubPath, installPath, unityVersion, unityVersionChangeset, selfHosted) {
    log('Starting installation of Unity Editor');
    log(`Looking for Unity version: ${unityVersion} at path: ${unityHubPath}`);
    let unityPath = await findUnity(unityHubPath, unityVersion);
    if (!unityPath) {
        log('Unity not found, proceeding with installation...');
        if (installPath) {
            log(`Install path set: ${installPath}`);
            if (process.platform === 'linux' || process.platform === 'darwin') {
                log(`Platform is ${process.platform}, preparing install directory...`);
                await execute(`mkdir -p "${installPath}"`, { sudo: !selfHosted });
                await execute(`chmod -R o+rwx "${installPath}"`, { sudo: !selfHosted });
                log('Install directory prepared');
            }
            await executeHub(unityHubPath, `install-path --set "${installPath}"`);
            log(`Install path configured in Unity Hub: ${installPath}`);
        }
        log(`Installing Unity version ${unityVersion} with changeset ${unityVersionChangeset}`);
        await executeHub(unityHubPath, `install --version ${unityVersion} --changeset ${unityVersionChangeset}`);
        unityPath = await findUnity(unityHubPath, unityVersion);
        log('Unity Editor installed successfully');
        if (!unityPath) {
            throw new Error('Unity Editor installation failed');
        }
    } else {
        log('Unity already installed at found path');
    }
    return unityPath;
}


async function installUnityModules(unityHubPath, unityVersion, unityModules, unityModulesChild) {
    const modulesArgs = unityModules.map(s => `--module ${s.toLowerCase()}`).join(' ');
    const childModulesArg = unityModulesChild ? '--childModules' : '';
    const stdout = await executeHub(unityHubPath, `install-modules --version ${unityVersion} ${modulesArgs} ${childModulesArg}`);
    if (!stdout.includes('successfully') && !stdout.includes("it's already installed")) {
        throw new Error('unity modules installation failed');
    }
}

async function findUnity(unityHubPath, unityVersion) {
    let unityPath = '';
    let output = await executeHub(unityHubPath, `editors --installed`);
    output = output.split("(Intel)");
    output = output.join("");
    output = output.split("(Apple silicon)");
    output = output.join("");
    const match = output.match(new RegExp(`${unityVersion} , installed at (.+)`));
    if (match) {
        unityPath = match[1];
        if (unityPath && process.platform === 'darwin') {
            unityPath += '/Contents/MacOS/Unity';
        }
    }
    return unityPath;
}

async function findProjectVersion(projectPath) {
    const filePath = path.join(projectPath, 'ProjectSettings/ProjectVersion.txt');
    if (fs.existsSync(filePath)) {
        log("Try to find m_EditorVersionWithRevision in project:", filePath);
        const fileText = fs.readFileSync(filePath, 'utf8');
        const match1 = fileText.match(/m_EditorVersionWithRevision: (.+) \((.+)\)/);
        if (match1) {
            const version = match1[1];
            const changeset = match1[2];
            return [version, changeset];
        }
        const match2 = fileText.match(/m_EditorVersion: (.+)/);
        if (match2) {
            const version = match2[1];
            const changeset = await findVersionChangeset(version);
            return [version, changeset];
        }
    }
    throw new Error(`Project not found at path: ${filePath}`);
}

async function findVersionChangeset(unityVersion) {
    log("Try to find unityVersionChangeset for ", unityVersion);
    let changeset = '';
    try {
        let versionPageUrl;
        if (unityVersion.includes('a')) {
            versionPageUrl = 'https://unity3d.com/unity/alpha/' + unityVersion;
        } else if (unityVersion.includes('b')) {
            versionPageUrl = 'https://unity3d.com/unity/beta/' + unityVersion;
        } else if (unityVersion.includes('f')) {
            versionPageUrl = 'https://unity3d.com/unity/whats-new/' + unityVersion.match(/[.0-9]+/)[0];
        }
        log("on url:", versionPageUrl);
        const pagePath = await tc.downloadTool(versionPageUrl); // support retry
        const pageText = fs.readFileSync(pagePath, 'utf8');
        const match = pageText.match(new RegExp(`unityhub://${unityVersion}/([a-z0-9]+)`)) || pageText.match(/Changeset:<\/span>[ \n]*([a-z0-9]{12})/);
        changeset = match[1];
    } catch (error) {
        core.error(error);
    }
    if (!changeset) {
        throw new Error("Can't find Unity version changeset automatically");
    }
    return changeset;
}

async function executeHub(unityHubPath, args) {
    if (process.platform === 'linux') {
        return await execute(`xvfb-run --auto-servernum "${unityHubPath}" --headless ${args}`, { ignoreReturnCode: true });
    } else if (process.platform === 'darwin') {
        return await execute(`"${unityHubPath}" -- --headless ${args}`, { ignoreReturnCode: true });
    } else if (process.platform === 'win32') {
        // unityhub always return exit code 1
        return await execute(`"${unityHubPath}" -- --headless ${args}`, { ignoreReturnCode: true });
    }
}

async function execute(command, options) {
    let stdout = '';
    const prefix = options?.sudo == true ? 'sudo ' : '';
    await exec.exec(prefix + command, [], {
        ignoreReturnCode: options?.ignoreReturnCode,
        listeners: {
            stdout: buffer => stdout += buffer.toString()
        }
    });
    console.log(); // new line
    return stdout;
}

function getInputAsArray(name, options) {
    return core
        .getInput(name, options)
        .split("\n")
        .map(s => s.trim())
        .filter(x => x !== "");
}

function getInputAsBool(name, options) {
    return core.getInput(name, options).toLowerCase() === 'true';
}

run();

