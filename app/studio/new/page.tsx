import { DeployForm } from "@/components/studio/deploy-form";
import { StudioHeader } from "@/components/studio/primitives";

/**
 * /studio/new — the deployment form (FR-STU-001 … FR-STU-007).
 *
 * There is no data to fetch here: everything the form needs comes from probing
 * the repository the creator types. So this is a thin Server Component whose
 * only job is the page heading and the client boundary.
 */
export const metadata = {
  title: "Deploy a model — Creator Studio",
};

export default function NewModelPage() {
  return (
    <div className="flex flex-col gap-6">
      <StudioHeader
        description="Point Studio at a Hugging Face repository and say what your model should do. Which hardware delivers it is solved from the weights and your settings — bigger cards are not always faster ones, so it is not a choice worth making by hand."
        title="Deploy a model"
      />
      <DeployForm />
    </div>
  );
}
