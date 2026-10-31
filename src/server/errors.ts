export class ApiError extends Error{
 constructor(readonly status:number,readonly code:string,message:string,readonly retryable=false){super(message);}
}
