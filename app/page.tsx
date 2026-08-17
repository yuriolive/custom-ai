import { HomeCards } from "@/components/home-cards";

export default function HomePage() {
  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col items-start gap-3">
        <h1 className="text-3xl font-semibold tracking-tight">
          Serverless inference, billed per token
        </h1>
        <p className="text-muted max-w-2xl">
          One OpenAI-compatible endpoint in front of scale-to-zero GPU workers.
          The marketplace, Creator Studio and Console are deferred — MVP-0 is the
          gateway and a playground to exercise it.
        </p>
      </section>

      <HomeCards />
    </div>
  );
}
