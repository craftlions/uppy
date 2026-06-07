// template.ts
import { defaultBuildLogger, Template } from "e2b";

export const template = Template()
	.fromBaseImage()
	.runCmd("curl https://mise.run | sh");

await Template.build(template, "uppy-base", {
	cpuCount: 4,
	memoryMB: 8192,
	onBuildLogs: defaultBuildLogger(),
});
