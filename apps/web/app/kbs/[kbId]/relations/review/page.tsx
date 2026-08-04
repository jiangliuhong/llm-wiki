import RelationReviewPage from "@/app/relations/review/page";

export default async function KnowledgeBaseRelationReviewPage({
  params,
}: {
  params: Promise<{ kbId: string }>;
}): Promise<React.ReactElement> {
  const { kbId } = await params;
  return <RelationReviewPage kbId={kbId} />;
}
