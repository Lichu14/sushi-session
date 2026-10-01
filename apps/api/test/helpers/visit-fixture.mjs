import {randomUUID,randomBytes,createHash} from 'node:crypto';

// Development only. Owns exactly one fresh restaurant; cleanup never targets user data.
export async function visitFixture(prisma){
  const id=randomUUID();
  const restaurant=await prisma.restaurant.create({data:{id,name:'Phase 3 test fixture',slug:id,status:'ACTIVE'}});
  const location=()=>prisma.restaurantLocation.create({data:{restaurantId:restaurant.id,name:'Fixture',slug:randomUUID(),addressLine1:'Fixture',city:'City',region:'Region',countryCode:'AR',timeZone:'America/Argentina/Buenos_Aires',status:'ACTIVE'}});
  const code=async(locationId,overrides={})=>{
    const token=randomBytes(32).toString('base64url');
    const row=await prisma.checkInCode.create({data:{locationId,tokenHash:createHash('sha256').update(token).digest('hex'),mode:'STATIC',validFrom:new Date(Date.now()-60000),status:'ACTIVE',...overrides}});
    return {row,token};
  };
  const cleanup=()=>prisma.$transaction(async tx=>{
    const locations=(await tx.restaurantLocation.findMany({where:{restaurantId:id},select:{id:true}})).map(r=>r.id);
    const visits=(await tx.visit.findMany({where:{locationId:{in:locations}},select:{id:true}})).map(r=>r.id);
    await tx.sushiSession.deleteMany({where:{visitId:{in:visits}}});
    await tx.visitCheckInEvidence.deleteMany({where:{visitId:{in:visits}}});
    await tx.visit.deleteMany({where:{id:{in:visits}}});
    await tx.checkInCode.deleteMany({where:{locationId:{in:locations}}});
    await tx.restaurantLocation.deleteMany({where:{id:{in:locations}}});
    await tx.restaurant.delete({where:{id}});
  },{timeout:30000});
  return {restaurant,location,code,cleanup};
}
