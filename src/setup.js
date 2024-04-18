const core = require('@actions/core');
const exec = require('@actions/exec');
const tc = require('@actions/tool-cache');
const path = require('path');
const fs = require('fs');

function log(...args) {
    if (getInputAsBool('verbose')){
        console.log(...args);
    }
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
        } else {
            log("List of unityModules wasn't provided, skipping their installation")
        }
        
        core.setOutput('unity-version', unityVersion);
        core.setOutput('unity-path', unityPath);
        core.exportVariable('UNITY_PATH', unityPath);
        core.exportVariable('UNITY_VERSION', unityVersion);
    } catch (error) {
        core.setFailed(error.message);
    }
}

async function installUnityHub() {
    log("Define unityHubPath on platform:", process.platform);
    let unityHubPath = '';
    if (process.platform === 'linux') {
        unityHubPath = `${process.env.HOME}/Unity Hub/UnityHub.AppImage`;
    } else if (process.platform === 'darwin') {
        unityHubPath = '/Applications/Unity Hub.app/Contents/MacOS/Unity Hub';
    } else if (process.platform === 'win32') {
        unityHubPath = 'C:/Program Files/Unity Hub/Unity Hub.exe';
    } else {
        throw new Error('Unknown platform');
    }

    if (!fs.existsSync(unityHubPath)) {
        log("Unity Hub is not installed. Automatic installation is disabled.");
    } else {
        log("Unity Hub is already installed in:", unityHubPath);
    }
    return unityHubPath;
}

async function installUnityEditor(unityHubPath, unityVersion) {
    let unityPath = await findUnity(unityHubPath, unityVersion);
    if (!unityPath) {
        log('Unity Editor not found. Automatic installation is disabled.');
    } else {
        log('Unity Editor is already installed at:', unityPath);
    }
    return unityPath;
}

async function installUnityModules(unityHubPath, unityVersion, unityModules, unityModulesChild) {
    const modulesArgs = unityModules.map(s => `--module ${s.toLowerCase()}`).join(' ');
    const childModulesArg = unityModulesChild ? '--childModules' : '';
    log(`Unity Modules will be installed with flag(s): ${modulesArgs} ${childModulesArg}`);

    const stdout = await executeHub(unityHubPath, `install-modules --version ${unityVersion} ${modulesArgs} ${childModulesArg}`);

    if (!stdout.includes('successfully') && !stdout.includes("it's already installed")) {
        throw new Error('Unity modules installation failed');
    }

    log('Unity modules installation completed successfully');
}

async function findUnity(unityHubPath, unityVersion) {
    log(`Looking for Unity version: ${unityVersion} at path: ${unityHubPath}`);
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
    log('Unity Editor path found successfully:', unityPath);
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

